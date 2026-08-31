# teamshare — AWS deployment

Terraform for a single, durable, always-on home for `teamshare` —
multi-team: one shared SQLite database can host any number of independent
teams, each invisible to the others, every team's agents reading their own
shared context. This directory is **author-only** output — it was written
and validated (`init`/`validate`/`fmt`) but never applied. Review it, then run
`terraform apply` yourself.

## What this creates, and what it costs

| Resource                                  | Purpose                  | Rough monthly cost (us-east-1, always-on)                                           |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| 1x `t4g.small` EC2 instance               | Runs teamshare + Caddy   | ~$12.30                                                                             |
| 20 GB `gp3` EBS root volume, encrypted    | Holds the SQLite DB      | ~$1.60                                                                              |
| 1x Elastic IP (associated)                | Stable address for TLS   | ~$3.60 (AWS bills all public IPv4 addresses hourly since Feb 2024, attached or not) |
| Dedicated VPC, subnet, IGW, route table   | Network path (see below) | $0                                                                                  |
| Security group, IAM role/instance profile | Access control, SSM      | $0                                                                                  |
| S3 bucket (versioned, encrypted)          | Daily database backups   | pennies — a few KB/day, lifecycle-managed (see below)                               |

**Total: roughly $15–20/month**, before data transfer (usage-dependent, and
small for an internal team tool).

There is no Route53 domain and no load balancer — TLS terminates on the box
itself via Caddy and [sslip.io](https://sslip.io), and the box's own Elastic
IP is the only stable address.

## Why one EC2 instance, not Lambda/Fargate/App Runner

teamshare stores **all** state for every team it hosts — each team's token,
members, shares, read receipts — in **one SQLite file**, and its own spec
requires **exactly one
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

Before the first `apply`, decide on a **signup secret** — see "Onboarding:
teams create themselves" below. Set it in `terraform.tfvars` (`signup_secret
= "..."`) if you want it recoverable from your own Terraform vars; leave it
unset and the server generates one on first boot instead, at the cost of the
break-glass SSM path being the only way to read it back later.

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
- `ssm_read_team_token_command` / `ssm_show_signup_secret_command` —
  break-glass only, see below. **Neither is the way to onboard a team** —
  that's the next section.

## Onboarding: teams create themselves

teamshare is multi-team: this one server can host any number of independent
teams, invisible to each other (see the root README's "Trust model"). Getting
a team onto it needs **no AWS account, no Terraform, no SSH/SSM access** —
that's the entire point of this design, and the two SSM outputs above are
break-glass fallbacks for when it doesn't apply, not the normal path.

**The operator does one thing, once:** choose the signup secret (the
`signup_secret` Terraform variable, above) and share it with the org through
whatever channel you'd otherwise have used to hand out tokens individually —
Slack, a wiki page, however you'd announce any other new internal tool. That
single secret replaces distributing a token per team.

**Recovering the secret**, if it was generated on first boot rather than set
via the `signup_secret` variable: `deploy/aws/signup-secret.sh` runs the
break-glass SSM read for you and prints the bare value and nothing else, so it
composes without the secret ever reaching a screen or shell history:

```bash
TEAMSHARE_SIGNUP_SECRET=$(deploy/aws/signup-secret.sh) teamshare-team create-team "My Team"
```

**A team lead creates their own team** with the plugin command — needing
nothing beyond Claude Code with teamshare installed:

```
/teamshare:generate-secret
/teamshare:create-team <org-name>
```

`generate-secret` first — create-team needs that secret. Recovering the live
value needs local terraform state or `TEAMSHARE_INSTANCE_ID`, never an id
shipped in the plugin. The curl'd `teamshare-team.mjs` file remains the
no-plugin fallback.

The signup secret is never a command-line argument — that would land it in
shell history and `ps` output. It's read from `TEAMSHARE_SIGNUP_SECRET` in
the environment, or, on a real terminal, prompted for with the input hidden.
This prints the new **admin token exactly once** (save it in a password
manager immediately — it cannot be recovered later, only rotated away) and
verifies it against the live server. This admin token is not something to
hand out — it mints invites, revokes access, reads the roster, and rotates
itself, but grants **no** access to shares, receipts, or the digest, for
anyone, including the lead.

**The step after that is new: the lead invites each member individually,**
rather than distributing that one token to the whole team:

```bash
node teamshare-team.mjs invite https://<ip>.sslip.io <email> ["<name>"]
```

This needs the admin token above, resolved the same way the signup secret
is — `TEAMSHARE_ADMIN_TOKEN` in the environment, or prompted for on a real
terminal, never a positional argument. It prints a token minted for that
one person, plus the same join instructions described in the root README's
["If you use Claude Code"](../../README.md#if-you-use-claude-code) section
— send those to that person directly (a DM, not the team channel); the
printed text says so explicitly, because this value is personal to them,
not a team-wide credential. See the root README's
["The team lead"](../../README.md#the-team-lead-once-per-team) and
["Admin"](../../README.md#admin) sections for `revoke`/`roster` and the
reasoning behind minting one token per person instead of one for the team.

**Rotation is the remedy for a lost or leaked admin token, and teams
self-serve it** — no operator involvement:

```bash
node teamshare-team.mjs rotate-team https://<ip>.sslip.io
```

Same env-var-or-prompt rule, this time for the team's _current_ admin token
(required to authenticate the rotation). This invalidates the old admin
token immediately — but **no teammate has to do anything**: member tokens
minted by `invite` are stored independently of the admin token, so this only
affects admin operations (`invite`/`revoke`/`roster`/another `rotate-team`),
never anyone's actual connection. If the admin token is genuinely gone
rather than merely leaked — so there's nothing left to authenticate a
self-serve rotation with — that's what the operator break-glass path below
is for.

## Break-glass: recovering a secret or token via SSM

These two Terraform outputs cover the cases self-serve can't — there's no
SSH key on this box at all, so both go over SSM Session Manager:

- **`ssm_show_signup_secret_command`** — if `signup_secret` was left unset at
  deploy time, the server generated one on first boot, and that value is
  deliberately never logged anywhere (see the design doc's §Creating a
  team). This reads it back directly off the box. Not needed at all if you
  set `signup_secret` explicitly in Terraform.
- **`ssm_read_team_token_command`** — reads the _original_ pre-multi-team
  token out of journal history: the one plaintext token this server ever
  printed unprompted, on its very first boot, before multi-team existed. It
  now belongs to the team named `default` (created during migration). Useful
  only if that team's lead lost their token before ever rotating it
  themselves — normal rotation is `rotate-team` above, not this.

```bash
# 1. Submit the command (either output above works the same way — this
#    example uses ssm_read_team_token_command)
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

If a team's admin token is genuinely lost (not leaked — actually gone, so
`rotate-team` above has nothing left to authenticate with), the operator can
force a new one directly on the box instead. This is the same `rotate-token`
the root README documents, run over SSM because there's no SSH key here —
`--team` names which team, and is required once this instance hosts more
than one. As with self-serve rotation, this only replaces the admin
credential; it does not touch any teammate's personal token from `invite`:

```bash
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl stop teamshare","sudo -u teamshare /usr/local/bin/node /opt/teamshare/packages/server/dist/cli.js rotate-token --team \"<name>\" --db /var/lib/teamshare/teamshare.db","systemctl start teamshare"]' \
  --region us-east-1
```

## How teammates connect

Every teammate connects with the **personal token their lead minted for
them with `invite`**, above — never the admin token `create-team`/
`rotate-team` produced, which doesn't grant data access at all.

- **Claude Code**: install the teamshare plugin and, when prompted, supply
  the server URL (`https://<ip>.sslip.io`) and that personal token. The
  prompt itself is still labeled "Team token" (a holdover from before this
  value became personal) — the token that goes there is theirs alone, sent
  to them privately, not something to post in a shared channel.
- **Everything else** (Cursor, VS Code, Windsurf, Gemini CLI, Cline, Zed,
  Continue, or any other MCP-capable assistant): no install needed — download
  `teamshare-connect.mjs` from the repo root and run it directly with plain
  Node:

  ```bash
  node teamshare-connect.mjs https://<ip>.sslip.io <personal-token>
  ```

  This writes the connection into that assistant's own config; no clone, no
  `pnpm install`, no build step. Run `teamshare doctor` (or the equivalent
  `node teamshare-connect.mjs` invocation — see the root README) any time to
  verify a given machine can actually reach the server. Right after
  `invite`/`create-team`/`rotate-team` mints a token, prefer the env-var
  form — `TEAMSHARE_URL=... TEAMSHARE_TOKEN=... teamshare doctor` — over
  pasting that real token as a positional argument.

## The Elastic IP (attached)

The instance has a **stable Elastic IP: `54.90.22.249`**, so its URL —
`https://54.90.22.249.sslip.io` — does not change. `use_elastic_ip` defaults
to `true`; setting it back to `false` releases the address and reintroduces
the fragility below.

**History, and why the code still guards against this:** the first deployment
had no Elastic IP because the account was at its quota (all addresses held by
p3m NAT Gateways and ALBs). An increase to 15 was requested and approved on
2026-08-29, and the address was attached.

Without an Elastic IP, a **stop/start** assigns a new public IP. That is worse
than it sounds: `user_data` runs `scripts-per-once`, so the Caddyfile's
hardcoded hostname would never be rewritten, and Caddy would serve a
certificate for a name that no longer resolved here — a silent, total outage.
`files/teamshare-hostname.sh` runs on every boot to prevent that, regenerating
the hostname from instance metadata before Caddy starts.

**Both halves were tested for real (2026-08-29):**

- _Before_ the Elastic IP: the instance was stopped and started, the IP changed
  (`44.223.81.180` → `100.54.34.193`), the boot unit rewrote the Caddyfile,
  Caddy issued a fresh certificate, and the server was healthy again in 25
  seconds unattended — where previously it would simply have died.
- _After_ the Elastic IP: stopped and started again, and the IP **stayed**
  `54.90.22.249`. Service back in 20 seconds, all three units active, database
  intact. The URL now survives a stop/start, so teammates never have to
  reconnect.

If the address is ever detached or replaced, run the healer to repoint Caddy
without waiting for a reboot:

```bash
aws ssm send-command --instance-ids "$(terraform output -raw instance_id)" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/bin/teamshare-hostname.sh"]' \
  --region us-east-1
```

## Guard against accidental destruction

The instance carries `lifecycle { prevent_destroy = true }`, because its root
volume holds every team's entire shared memory — every share, receipt,
member, and token, for every team on this instance. Combined with
`user_data_replace_on_change`, editing
`user_data.sh.tpl` and running `terraform apply` would otherwise replace the
box and silently wipe all of it.

The same `lifecycle` block also sets `ignore_changes = [user_data]`. Since
`user_data.sh.tpl` is expected to keep gaining setup steps over time (the S3
backup automation added here is the first), that attribute will keep
differing from the template's rendered output on every future `apply` from
now on. Without `ignore_changes`, _every_ such `apply` — even one only
touching unrelated resources, like an S3 bucket that has nothing to do with
the instance — would attempt to replace this box, which `prevent_destroy`
then turns into a hard error blocking the entire apply. `ignore_changes`
keeps the actual guarantee (this instance is never replaced by routine
`apply`) without that collateral damage.

To intentionally rebuild the box: back up the database (below), remove
**both** `prevent_destroy` and `ignore_changes = [user_data]` from the
`lifecycle` block in `ec2.tf` (removing only `prevent_destroy` isn't enough —
the rebuild would otherwise boot with today's already-ignored `user_data`
instead of the current template), apply, then restore. To tear the whole
stack down: remove the block and run `terraform destroy`.

## Backing up the database

**The SQLite file at `/var/lib/teamshare/teamshare.db` is the entire shared
memory for every team on this instance** — every share, every read receipt,
every team's token. There is exactly one copy, on one EBS volume, on one
instance. If that volume
dies, this is gone with no recovery — so backups are automated, not manual.

### How it works

A `teamshare-backup.timer` (installed by `user_data.sh.tpl`, enabled at boot)
runs `teamshare-backup.service` once a day. `Persistent=true` means a run
that was missed because the instance was stopped fires as soon as it's back
up. Each run:

1. Takes a **SQLite online backup** (`sqlite3 ... ".backup <dest>"`) into a
   temp file — never a raw `cp`. teamshare holds the database open in WAL
   mode; copying the file directly can grab a torn, inconsistent snapshot
   mid-write. The online backup API is safe against a live writer.
2. Runs `PRAGMA integrity_check` against the temp copy and **aborts without
   uploading** if it doesn't come back `ok`. An unverified backup looks like
   protection and isn't.
3. Uploads to `s3://<bucket>/teamshare/YYYY/MM/DD/teamshare-<UTC timestamp>.db`
   in the bucket from the `backup_bucket` output (`teamshare-backups-<this
account's ID>` — see `backup.tf`).
4. Deletes the temp file.

The bucket blocks all public access, encrypts everything by default (SSE-S3),
and has versioning on. A lifecycle rule expires noncurrent object versions
after 90 days and aborts abandoned multipart uploads after 7, so it doesn't
grow without bound. The instance's IAM role can only `PutObject`/`GetObject`
on this bucket's objects and `ListBucket` on the bucket itself — nothing
wider.

The **entire backup script is one file**,
[`deploy/aws/files/teamshare-backup.sh`](files/teamshare-backup.sh) — it's
embedded verbatim into `user_data.sh.tpl` (base64, so it never passes through
Terraform's own `${...}` templating and can't drift from this copy) and can
also be delivered as-is to the _already-running_ instance over SSM, without
touching `user_data` or replacing the box:

```bash
# Base64 the script (one line, no embedded quotes/backslashes to escape —
# same trick user_data.sh.tpl uses) and write a small SSM parameters file
# rather than hand-escaping shell-inside-JSON on the command line.
B64=$(base64 < deploy/aws/files/teamshare-backup.sh | tr -d '\n')
printf '{"commands":["echo %s | base64 -d > /usr/local/bin/teamshare-backup.sh","chmod 0750 /usr/local/bin/teamshare-backup.sh","/usr/local/bin/teamshare-backup.sh"]}' \
  "$B64" > /tmp/deliver-teamshare-backup.json

aws ssm send-command \
  --instance-ids "$(terraform output -raw instance_id)" \
  --document-name "AWS-RunShellScript" \
  --parameters file:///tmp/deliver-teamshare-backup.json \
  --region us-east-1 \
  --query "Command.CommandId" --output text

rm -f /tmp/deliver-teamshare-backup.json
```

This writes the exact same bytes to `/usr/local/bin/teamshare-backup.sh` that
`user_data.sh.tpl` would have written on first boot, then runs it once
immediately (useful to confirm it works right after wiring it up, ahead of
its first scheduled run).

Check that a run actually happened, and see any failures, with:

```bash
aws ssm send-command \
  --instance-ids "$(terraform output -raw instance_id)" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["journalctl -u teamshare-backup --no-pager -n 50"]' \
  --region us-east-1
```

### Listing backups

```bash
aws s3 ls s3://teamshare-backups-<account-id>/teamshare/ --recursive --region us-east-1 | sort | tail -n 20
```

(This exact command, with the real bucket name filled in, is also printed as
the `list_recent_backups_command` Terraform output.)

### Restoring a backup

**A backup nobody has restored is not yet a backup.**

This procedure has been tested end to end against the live instance
(2026-08-29): a canary share was published _after_ a backup was taken, the
backup was restored by these exact steps, and the canary was confirmed gone
afterwards with the service healthy — proving the database was genuinely
replaced rather than the restore silently no-opping. Re-test it yourself
after any change to this stack, before you ever need it under pressure — restore into a
scratch instance if you want zero risk to the live database, or do a real
restore during a low-traffic window if you're confident. Either way, confirm
you can actually get data back out, not just that uploads are landing in S3.

The service **must be stopped before the swap** — otherwise the live process
can write to `teamshare.db` (or leave WAL/SHM files around) while you're
replacing it underneath it, corrupting the result. There's no SSH key on
this box, so do it over an SSM Session Manager shell — this avoids
hand-escaping shell commands inside JSON, and lets you watch each step:

```bash
# 1. Open an interactive shell on the instance (no SSH key needed)
aws ssm start-session --target "$(terraform output -raw instance_id)"

# --- everything below runs *inside* that session, as root ---

# 2. Pick a backup key from the listing above, e.g.:
BUCKET="teamshare-backups-<account-id>"   # from the backup_bucket output
KEY="teamshare/2026/08/29/teamshare-20260829T030000Z.db"

# 3. Stop the service first — nothing may write to teamshare.db during the swap.
systemctl stop teamshare

# 4. Fetch the chosen backup to a scratch path.
aws s3 cp "s3://${BUCKET}/${KEY}" /tmp/teamshare-restore.db --region us-east-1

# 5. Verify its integrity before trusting it — do not skip this.
INTEGRITY=$(sqlite3 /tmp/teamshare-restore.db "PRAGMA integrity_check;")
[ "$INTEGRITY" = "ok" ] || { echo "INTEGRITY CHECK FAILED: $INTEGRITY"; exit 1; }
echo "integrity check passed"

# 6. Keep the current live database in case this restore itself is a mistake.
cp -a /var/lib/teamshare/teamshare.db "/var/lib/teamshare/teamshare.db.pre-restore-$(date +%Y%m%d%H%M%S)"

# 7. Clear any leftover WAL/SHM siblings from the *previous* live database.
#    A `.backup` copy is fully checkpointed into one file with nothing
#    pending, so stale WAL/SHM files next to it would otherwise be replayed
#    against the wrong base file on next start.
rm -f /var/lib/teamshare/teamshare.db-wal /var/lib/teamshare/teamshare.db-shm

# 8. Replace the live database with the verified backup.
mv /tmp/teamshare-restore.db /var/lib/teamshare/teamshare.db
chown teamshare:teamshare /var/lib/teamshare/teamshare.db

# 9. Restart and confirm.
systemctl start teamshare
sleep 2
systemctl is-active teamshare   # must print "active" before you tell anyone this is done
journalctl -u teamshare --no-pager -n 20   # sanity-check it came up cleanly

# 10. Leave the session
exit
```

If you need this to run non-interactively instead (e.g. from a script), the
same nine commands can be sent as one `aws ssm send-command` by putting them
in a local JSON file — e.g. `{"commands": ["systemctl stop teamshare", "aws s3 cp ...", ...]}`
— and passing `--parameters file://restore-params.json`, which avoids the
inline shell-inside-JSON escaping that typing the array directly on the
command line would require.

## Tearing it down

```bash
terraform destroy
```

**This permanently deletes the EC2 instance and its EBS volume — which means
every team's shares, read receipts, and tokens, gone, with no recovery short
of a backup you took yourself per the section above.** There is no
snapshot or recycle bin here. Take a backup first if there is any chance you
might want this data again.
