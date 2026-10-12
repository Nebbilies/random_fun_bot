# Character Game

Language for the character catalog, ownership, and tag review.

## Language

**Character identity**:
The stable AniList ID of a character, independent of its popularity rank or current catalog membership.
_Avoid_: Rank, catalog position

**Character ownership**:
The association of one player with a character in one Discord server. A character has at most one owner per server.
_Avoid_: Global ownership, character copy

**Character catalog**:
The current set of eligible characters and their display metadata. Membership and popularity rank can change on refresh.
_Avoid_: Ownership registry

**Retained character**:
An owned character no longer in the current catalog. It remains usable for trading and battles and keeps its last known name, AniList portrait, and approved tag mapping.
_Avoid_: Deleted character

**Character tag mapping**:
The association between a character and a tag used to find that character's images.
_Avoid_: Character mapping, tag match

**Character tag report**:
A viewer's flag that a character's tag mapping may be wrong or missing. A report does not propose a replacement tag.
_Avoid_: Correction, tag suggestion

**Reported character**:
A character with one or more unresolved character tag reports, presented as one item for review.
_Avoid_: Reported tag, duplicate report

**Report resolution**:
A review outcome that corrects a character tag mapping, dismisses its open reports, or marks a missing catalog character as unavailable.
_Avoid_: Approval

**Report correction**:
A tag mapping chosen while resolving reports, replacing the mapping that viewers flagged.
_Avoid_: Tag suggestion
