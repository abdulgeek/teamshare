---
description: Recover the live signup secret, or mint one for a brand-new server
argument-hint: "[--new]"
---

# Generate (or recover) the signup secret

The signup secret is what stops strangers creating teams on your server.

This command is **not** a required step before `/teamshare:create-team`.
create-team recovers the live secret itself. Use this when they want a copy
of the live value in a password manager, or when they are standing up a
server that does not exist yet (`--new`).

## Steps

1. **Recover** the live secret when this machine can name the instance:

   ```bash
   teamshare-team generate-secret
   ```

   Recover needs `TEAMSHARE_INSTANCE_ID`, local `deploy/aws/terraform.tfstate`,
   or `~/.teamshare/instance.json` written after a previous recover. The
   plugin does not ship an instance id.

2. **Against the hosted default server**, if recover is not possible, the
   command **fails** and prints no `tss_…` value. That is correct: a minted
   secret is not on that server, and feeding it to create-team is a 401.
   Relay the error. Do not invent a secret. Do not tell them to pass a
   minted value into create-team.

   Next: `/teamshare:create-team <name>` still, from the Terraform checkout
   or after `TEAMSHARE_INSTANCE_ID` is set.

3. **`--new`** mints a correctly-formed secret for a server they have not
   configured yet. Say once that it is not on any server until they set
   `TEAMSHARE_SIGNUP_SECRET` or the Terraform `signup_secret` variable.
   Never use that mint against the already-running hosted server.

4. **Relay recovered output as-is**, including the secret, once. Do not
   repeat it later.

## Failure handling

- Recover failed on the hosted server — they need `TEAMSHARE_INSTANCE_ID` or
  to run this (or create-team) from the checkout that has terraform state.
  Do not invent an instance id, and do not fall back to a value from memory
  or a previous conversation.
- `command not found` — this session started before the plugin's `bin/` was
  on PATH. Restart Claude Code.

## Rules

- The secret never goes on a command line.
- Print it once, as the command emits it.
- Never look up, guess, or hardcode an AWS instance id.
- Never hand a "not yet on any server" mint to `/teamshare:create-team`.
