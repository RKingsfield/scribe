# Next steps

Designated TODO home for scribe. Candidate work and open threads, not commitments.

## Accessibility

- **Restore eslint-plugin-jsx-a11y when it supports ESLint 10.** Removed because
  6.10.2 (latest) caps peer dep at ^9. Had 67 warnings (mostly dnd-kit false
  positives). Watch upstream for a release with ESLint 10 support, then re-add
  with the warn-downgrade config from git history.

## Sync edge cases

- **CodeMirror-driven ChapterFlow test for the buffer registry.** Belt-and-braces
  for the conflict modal's per-scene buffer lookup: render ChapterFlow with the
  real hook + fake-indexeddb, drive one scene to `blocked` via a recorded
  conflict, assert the lookup returns its buffer. Covered today at the banner
  boundary plus a registration test.

- **Return an `updated` list from `POST /scene/move` like `/reorder` does.** The
  flush clears queued-delete etag guards from the request-derived path list, so
  a path the backend skipped (malformed frontmatter) is over-cleared — a
  four-way-coincidence residue today, closed cleanly by an authoritative
  response list. See DESIGN #21.

## Feature candidates

- **Project archival workflow.** A "finalise/archive" state to skip finished
  projects in sync keepalive and review-token walks. No design yet.
