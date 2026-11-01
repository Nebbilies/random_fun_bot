# Character gender reviews

## Reporting

**Report gender** accompanies **Report tag** on character lookup and roll cards. It flags the character for review; it does not ask the viewer to suggest a gender. There is no new text or slash command.

Any viewer may report. A viewer can have one unresolved gender report per character across all servers. Different viewers' reports are grouped into one gender review case. After resolution, a viewer may report the character again. Roll reporting uses the same availability window as tag reporting.

Tag and gender reports are independent: resolving either kind does not close the other.

## Review workflow

The portal has a separate gender review workspace for administrators and moderators. Cases are ordered oldest first. Reviewers may:

- Correct the gender to **Female**, **Male**, **Non-binary**, or **Unknown**.
- Dismiss the reports when no correction is needed. Selecting the existing gender is a dismissal, not a correction.
- Choose **Use source gender** to remove a reviewed override and return an imported character to source-managed gender.

A correction to an imported character is a narrow, durable gender override. Future source refreshes must preserve it without permitting unrelated imported metadata edits. Removing it returns the character to its source gender, including subsequent source changes.

Resolution history attributes corrections and dismissals to the reviewer and records the before/after gender. Stale submissions must be rejected when the case has been resolved or changed since it was loaded. Changes to catalog gender and closure of the reports are atomic, with the catalog revision updated when gender changes.

## Gameplay

This feature does not change gender-filtered roll eligibility: Female qualifies for the female pool, Male for the male pool, and Non-binary and Unknown qualify for both. Existing active interactions retain their captured character data; newly read catalog data uses the reviewed gender.
