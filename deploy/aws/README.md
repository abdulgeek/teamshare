# teamshare — AWS deployment

Terraform for a single, durable, always-on home for the team's `teamshare`
server: one shared SQLite database, one team token, everyone's agent reads
the same context. This directory is **author-only** output — it was written
and validated (`init`/`validate`/`fmt`) but never applied. Review it, then run
`terraform apply` yourself.

## What this creates, and what it costs

| Resource | Purpose | Rough monthly cost (us-east-1, always-on) |
|---|---|---|
| 1x `t4g.small` EC2 instance | Runs teamshare + Caddy | ~$12.30 |
| 20 GB `gp3` EBS root volume, encrypted | Holds the SQLite DB | ~$1.60 |
| 1x Elastic IP (associated) | Stable address for TLS | ~$3.60 (AWS bills all public IPv4 addresses hourly since Feb 2024, attached or not) |
| Dedicated VPC, subnet, IGW, route table | Network path (see below) | $0 |
| Security group, IAM role/instance profile | Access control, SSM | $0 |

**Total: roughly $15–20/month**, before data transfer (usage-dependent, and
small for an internal team tool).

There is no Route53 domain and no load balancer — TLS terminates on the box
itself via Caddy and [sslip.io](https://sslip.io), and the box's own Elastic
IP is the only stable address.

## Why one EC2 instance, not Lambda/Fargate/App Runner

teamshare stores **all** team state — the team token, members, shares, read
receipts — in **one SQLite file**, and its own spec requires **exactly one
writer process on a real local disk**; it explicitly warns that SQLite's WAL
mode misbehaves on network filesystems (EFS, NFS, etc.). That constraint
rules out every horizontally-scalable AWS compute option:

- **Lambda** — no persistent local disk between invocations, and concurrent
  invocations would mean concurrent writers to the same file.
- **Fargate + EFS** — EFS is a network filesystem; this is precisely the
  configuration the teamshare spec warns against.
- **App Runner / an Auto Scaling Group with >1 instance** — any design that
  can run more than one writer against the same DB file at once will corrupt
  it, silently or otherwise.

So: **one** `t4g.small` EC2 instance, with a real EBS volume as its root
disk, running forever. Do not "improve" this into something that scales
out — that is the one thing that would actually break it.

## Two decisions made during authoring — please check these

The brief specified two things that turned out not to match this AWS
account/region when checked live (`aws ssm get-parameter`, `aws ec2
describe-vpcs`). Both are called out in `variables.tf` next to the affected
variable; summarizing here:

1. **AMI SSM parameter path.** The brief said
   `/aws/service/ami-al2023/ami-al2023-kernel-default-arm64`. That path does
   not exist as a public SSM namespace at all (verified — AWS rejects it as
   "not a valid namespace", not a permissions issue). The real, verified path
   for the same AMI is
   `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`
   (confirmed live: resolves to `ami-0cded71ff6ab7f608` in us-east-1). That's
   what `ec2.tf` / `variables.tf` (`ami_ssm_parameter`) actually use.
2. **No default VPC.** This account has no default VPC in us-east-1
   (verified live). It does have two other, unrelated VPCs
   (`10.20.0.0/16`, `10.0.0.0/16`) whose purpose and ownership weren't part
   of this brief, so guessing which one — if either — teamshare should join
   felt riskier than the alternative. `network.tf` therefore provisions a
   small, dedicated public VPC/subnet/Internet Gateway/route table just for
   this instance ($0 additional cost). If you'd rather teamshare live in one
   of the existing VPCs, point `aws_subnet.teamshare` (or just the
   `subnet_id` used in `ec2.tf`) at an existing public subnet instead and
   drop `network.tf`.

One more thing worth flagging even though it isn't a mismatch: the teamshare
CLI's `serve` command has **no `--host`/bind-address flag** — it calls
Express's `app.listen(port)` with no host argument, which binds every
network interface, not just localhost. There's no way to make the process
itself listen on `127.0.0.1` only. Exposure is controlled entirely by the
security group instead: only 80 and 443 are open, so port 8787 is never
reachable from outside the instance regardless of which interface the
process binds. This is called out again in the systemd unit
(`user_data.sh.tpl`).

## Deploying

```bash
cd deploy/aws
terraform init
terraform plan     # review what it would create
terraform apply     # you run this — not run as part of authoring this
```

State is **local** (`terraform.tfstate` in this directory) — deliberately not
in the team's existing `p3m-terraform-state-prod`/`-qa` S3 buckets, which
this stack never touches. Back up or commit-ignore that state file as you
see fit; losing it doesn't lose the database, only Terraform's bookkeeping
(a `terraform import` can always reconstruct it from the console if needed).

`apply` takes a few minutes: EC2 launch, then `user_data` runs in the
background — installing build tools, Node 20, pnpm, cloning and building
teamshare, installing Caddy, and starting both systemd units. Caddy retries
its Let's Encrypt issuance on its own until the Elastic IP association
completes and DNS (`sslip.io`, which just echoes the IP back, no propagation
delay) resolves — no custom wait loop needed, but give it a minute or two
after `apply` finishes before hitting the HTTPS URL.

Terraform prints, on success:
- `elastic_ip` — the static IP.
- `url` — `https://<ip>.sslip.io`.
- `ssm_read_team_token_command` — see below.

## Retrieving the team token

The team token is generated **on the instance**, the first time the server
starts, and is printed exactly once to stdout — which, under systemd, lands
in the journal. It is never in Terraform state, never in this repo, and
never transmitted anywhere by this Terraform. Read it via SSM (no SSH key
exists on this box at all):

```bash
# 1. Submit the command (this is exactly the `ssm_read_team_token_command` output)
CMD_ID=$(aws ssm send-command \
  --instance-ids <instance-id-from-output> \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["journalctl -u teamshare --no-pager | grep -A2 \"Team token\""]' \
  --region us-east-1 \
  --query "Command.CommandId" --output text)

# 2. Fetch the result (allow a few seconds for it to run)
aws ssm get-command-invocation \
  --command-id "$CMD_ID" \
  --instance-id <instance-id-from-output> \
  --region us-east-1 \
  --query "StandardOutputContent" --output text
```

If you ever need a fresh token instead (e.g. suspected leak), SSM in a
`rotate-token` run the same way:

```bash
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl stop teamshare","sudo -u teamshare /usr/local/bin/node /opt/teamshare/packages/server/dist/cli.js rotate-token --db /var/lib/teamshare/teamshare.db","systemctl start teamshare"]' \
  --region us-east-1
```

## How teammates connect

- **Claude Code**: install the teamshare plugin and, when prompted, supply
  the server URL (`https://<ip>.sslip.io`) and the team token from above.
- **Everything else** (Cursor, VS Code, Windsurf, Gemini CLI, Cline, Zed,
  Continue, or any other MCP-capable assistant): no install needed — download
  `teamshare-connect.mjs` from the repo root and run it directly with plain
  Node:

  ```bash
  node teamshare-connect.mjs https://<ip>.sslip.io <team-token>
  ```

  This writes the connection into that assistant's own config; no clone, no
  `pnpm install`, no build step. Run `teamshare doctor` (or the equivalent
  `node teamshare-connect.mjs` invocation — see the root README) any time to
  verify a given machine can actually reach the server.

## Backing up the database

**The SQLite file at `/var/lib/teamshare/teamshare.db` is the entire team's
shared memory** — every share, every read receipt, the team token itself.
There is exactly one copy, on one EBS volume, on one instance. Back it up
regularly; an EBS snapshot alone is a reasonable belt-and-suspenders addition
but isn't a substitute for an application-level backup, since the app's
WAL/SHM side files need to be in a consistent state relative to the main
file. The safest copy is a brief-stop-then-copy, via SSM (no SSH needed):

```bash
aws ssm send-command \
  --instance-ids <instance-id> \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "systemctl stop teamshare",
    "cp -a /var/lib/teamshare/teamshare.db /var/lib/teamshare/teamshare.db.bak-$(date +%Y%m%d%H%M%S)",
    "systemctl start teamshare"
  ]' \
  --region us-east-1
```

The stop/copy/start window is sub-second for a database this size, so it is
not a meaningful availability concern. Copy the resulting `.bak-*` file
somewhere durable (S3, your laptop via `aws ssm start-session` + a file
transfer plugin, etc.) — this Terraform doesn't provision an S3 bucket or
schedule for that, since neither was in scope; add one if you want automated
offsite backups.

## Tearing it down

```bash
terraform destroy
```

**This permanently deletes the EC2 instance and its EBS volume — which means
every share, every read receipt, and the team token, gone, with no recovery
short of a backup you took yourself per the section above.** There is no
snapshot or recycle bin here. Take a backup first if there is any chance you
might want this data again.
