# Form fields: World Is Flat (worldisflat.fun)

- **Submit at:** https://worldisflat.fun/build → sign in → edit submission. Edits close Thu 12 Nov 2026, 17:30 UTC.
- **Texts to paste:** [SUBMISSION.md, *Form fields*](../../SUBMISSION.md#form-fields-worldisflatfun-edit-submission),
  one block per field of the table below, in the same order and within the same caps (`test/docs.test.ts` checks
  both). This file only maps the form: it holds no text to paste.
- **Rule:** in every field, select all (Cmd+A) and paste the block over it (the form opens with the answers of 2 Nov, and its maxlength cuts the rest without a word); in *transactions*, delete every item that is there first. The team step has no full-name field; the prize wallet goes only in payout_address, typed by the owner in the form. Nobody but the owner registers, saves or submits anything.

Source: the form's own script, https://worldisflat.fun/build/assets/js/form.js?v=0d65455f4eb5 (read on 8 Nov 2026).
A cap is the field's `maxlength`; a list is split at spaces and commas, one item per line.

### Team
The team step has no full-name field; the prize wallet goes only in payout_address, typed by the owner in the form. The lead's own fields (email, GitHub profile, handle, payout wallet) are typed there by the owner and never
written in this repo: it is public. The team is the owner (@0xultravioleta), the lead, and c0der, added as a member
only if the owner decides.

### The form's fields, in its order

| step | field | key | kind | cap | what goes in |
|---|---|---|---|---|---|
| your team | team name | `team_name` | text | 60 | as on 2 Nov |
| your team | email | `email` | email | 254 | the lead's own, only the organisers see it |
| your team | github profile of the lead | `github_profile` | text | 100 | the lead's own |
| your team | telegram or discord handle | `contact_handle` | text | 60 | the lead's own (optional) |
| your team | payout wallet | `payout_address` | text | 42 | the prize wallet, typed by the owner in the form |
| your project | project name | `name` | text | 60 | SUBMISSION.md |
| your project | one liner | `one_liner` | text | 80 | SUBMISSION.md |
| your project | category | `category_slugs` | categories | - | SUBMISSION.md (a choice) |
| your project | what it does | `what_it_does` | area | 1500 | SUBMISSION.md |
| your project | who it's for | `who_its_for` | area | 500 | SUBMISSION.md |
| how it connects to $wif | how does it use $wif | `wif_usage` | area | 1000 | SUBMISSION.md |
| how it connects to $wif | integration type | `integration_types` | multi | - | SUBMISSION.md (a choice) |
| how it connects to $wif | contract addresses | `contract_addresses` | list | - | empty (optional) |
| how it connects to $wif | we're ok with wif linking, featuring or integrating this project | `ok_to_feature` | check | - | ticked |
| your flywheel | what does someone do | `flywheel_action` | area | 500 | SUBMISSION.md |
| your flywheel | what happens to $wif when they do it | `flywheel_wif` | area | 500 | SUBMISSION.md |
| your flywheel | why does that bring them, or others, back | `flywheel_return` | area | 500 | SUBMISSION.md |
| proof of build | github repo | `repo_url` | url | 300 | SUBMISSION.md |
| proof of build | demo video | `demo_video_url` | url | 300 | SUBMISSION.md |
| proof of build | live link | `live_url` | url | 300 | SUBMISSION.md |
| proof of build | transactions | `tx_hashes` | list | - | SUBMISSION.md: hashes only, one per line |
| proof of build | how it's made | `how_its_made` | area | 1500 | SUBMISSION.md |
| proof of build | what's next | `whats_next` | area | 500 | SUBMISSION.md (optional) |

The project logo is a slot after *project name*, already uploaded (`docs/video/logo.png`). The last step, *review*,
shows every answer and the terms.
