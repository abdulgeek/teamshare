---
description: Share context with the team via teamshare
argument-hint: "[what you want the team to know]"
---

# Share with the team

Publish a short, high-signal note that every teammate's agent surfaces at their
next session start.

1. Use the `share-format` skill to distill the user's message — the arguments to
   this command, or if empty, ask what they want to share. It also decides
   whether the note is team-wide, scoped to one repository, or addressed to
   specific people.
2. Show the formatted share and get confirmation.
3. Call the teamshare `share` tool.
4. Report the share id and who will be notified — a count for a team-wide or
   scoped share, the named recipient(s) for an addressed one.

If the teamshare tools are not available, tell the user the connection is down
and point them at `/teamshare:status`, which distinguishes "not connected" from
"nothing new" — the two look identical otherwise. Do not retry.
