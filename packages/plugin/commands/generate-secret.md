---
description: Mint a signup secret, or recover the live one on an operator machine
argument-hint: "[--new]"
---

# Generate (or recover) the signup secret

The signup secret is what stops strangers creating teams on your server. This
command mints a correctly-formed one, or recovers the live value **only** when
this machine already knows which box to ask — never from an id shipped in the
plugin.

## Steps

1. **Mint**, unless this machine is the one that applied the AWS stack:

   ```bash
   teamshare-team generate-secret
   ```

   With no instance id in the environment and no local terraform state, that
   prints a new `tss_…` value. It is not on any server until they configure
   `serve` or Terraform with it. Say that once.

   Pass `--new` to force a mint even on an operator machine.

2. **Recover** only happens when this machine already knows the instance —
   `TEAMSHARE_INSTANCE_ID` in the environment, or `deploy/aws/terraform.tfstate`
   from a local `terraform apply`. The plugin does not ship an instance id;
   a public install must not know which box to point SSM at.

3. **Relay the output as-is**, including the secret. They need a copy in a
   password manager. Do not repeat it later in the conversation.

4. **Next step**, in your own words: `/teamshare:create-team <name>`.

## Failure handling

- Recover failed and they expected the live value — they need
  `TEAMSHARE_INSTANCE_ID` or to run this from the checkout that has terraform
  state. Do not invent an instance id, and do not fall back to a value from
  memory or a previous conversation.
- `command not found` — this session started before the plugin's `bin/` was
  on PATH. Restart Claude Code.

## Rules

- The secret never goes on a command line.
- Print it once, as the command emits it.
- Never look up, guess, or hardcode an AWS instance id.
