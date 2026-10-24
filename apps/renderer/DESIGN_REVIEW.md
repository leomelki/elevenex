# Component design review

## Updated reference review, 2026-10-24

The updated JobBrief, NewProject, ProjectMenu, ProjectSettings and Sheet families
are ported into Angular, with the changed project marks/rail, task wizard,
sub-task outline/header, automatic helper sessions and GitBar job states.
Reusable exports include RepoTag, SubtaskGlyph, ModalLayer, settings controls,
project-face/launch/landing helpers, fitted picker highlights and live tickers.
The changed normative inputs were imported verbatim; all 86 imported project
specification/token/index files still match the supplied extraction byte for byte.

This review used the running reference bundle and actual Angular components in
native Electron, with the same local fonts and supplied data. The temporary
reference server externalized its inline scripts to satisfy the existing CSP;
the reference extraction and application security settings were preserved.
The in-app browser connection was unavailable. No synthetic capture fixture was
used as product evidence.

Measured checks include:

- NewProject initial/Look cards: 540×275 and 540×383; folder field 480px,
  popup 482px, positioned 1px before the field. The popup follows ancestor
  transforms through bounded frames and releases observers/listeners on close.
- Settings: 860×560 with 217px navigation; narrow sheet 552×560, tabs 552×47,
  scroll 552×522 and repository list 504×527. Hero and setting-row boxes match
  the reference, including their positions outside the visible scroll window.
- NewTask: 600×355; Workspace at relative y=244, 26px high; Link at y=272,
  20px high; footer action at y=313, 30px high. The reference and Angular
  Workspace/Link widths are identical. Existing branches still advance to From
  and focus the native Create button before confirmation.
- Sub-task trees: one visual indent, capped stair marks, selected/hovered
  ancestry, delayed path hints, overflow, merged rows, helper-session marks and
  repository tags. RepoTag explicitly retains the reference's content-box sizing
  under the renderer's border-box reset.
- Modal reversal: before/after reversal opacity differs by less than .005,
  transform matrix terms by less than .002 and rectangles by less than .05px.
  Both modal surfaces and the receding shell were measured; reduced motion
  cancels owned animations. Opener focus survives child autofocus and nested
  confirmations.
- Project launch: the reference arc, face/name handoff, landing squash/ring,
  interruption and reduced motion were captured. Git and bulk-sidebar motion
  regressions preserve native button/row identity and continuous boundaries.
- Retained exits: NewProject and the repository-add form preserve their visible
  drafts/results while inert and abort pending folder work. Typing in New task
  during project landing survives the handoff. Queued height observations after
  detachment/destruction are ignored, including during route changes.

Corrections discovered through native validation included the wizard's native
button query, popup positioning during card entry, modal transform origin and
reversal continuity, nested focus restoration, settings row sizing, dark shadows,
and Workspace/Link geometry. Workbench counts now include nonmerged sub-task
sessions and forward their session-creation intents.

The reference caches some integer label widths before its fonts settle.
Angular measures loaded text and observes later changes: a reference label may
initially reserve about 2px too much, and live control widths can differ by a
fraction of a pixel (the measured Next button was 81.15625px versus 81px).
These stale-width/rounding artifacts were not reproduced. Computed token colors
match; cropped and full-viewport PNGs may carry different color-profile metadata.
This is measured visual/motion parity for the updated families, not a claim that
every exported PNG is pixel-identical or that unchanged families have been
re-audited. The earlier gaps below remain documented for their respective areas.

See [VERIFICATION.md](VERIFICATION.md) for the final reports and check results.

Reviewed on 2026-10-22 against `docs/design-system/project/README.md`, the
authoritative `tokens.css`, and the individual component specifications. Four
parallel reviewers covered foundations, conversation, tasks/views, and an
independent final review; the main review covered machines, shell composition,
and native captures.

## Assessment

The implemented families generally share the intended colors, glass/surface
layers, typography, spacing, and status vocabulary. Both fonts are bundled;
light/dark colors come from the authoritative tokens. The main shell uses the
specified rail/sidebar/panel sizes and gutters, and keeps covered regions inert.
Components use typed inputs/outputs and keep platform operations outside the
presentation layer. Large file lists and terminal output have bounded rendering.

This is a substantial implementation, but it does **not yet match every designed
interaction and animation**. The remaining gaps below are distinct from the
platform integrations intentionally left to future application owners.

## Corrections made

| Area | Corrected behavior |
| --- | --- |
| Approvals | Enter on a focused Deny or Always allow button preserves that button's action. |
| Composer | Tools-menu mentions insert at the caret without requiring a typed `@`; filtered suggestions reset selection and expose the active option. |
| Session start | Keyboard shortcuts only select visible presets; subsequent owner selection updates replace local choices. |
| Conversation evidence | Turn facts are bounded and ordered, unresolved failures stay visible, and step counts exclude prose. |
| Shared motion | AutoHeight includes padding/borders and resumes from the displayed height; Fold recovers after cancellation and uses its specified content delay. |
| Exit behavior | Departing Presence content, toasts, and view tabs are inert and hidden from assistive technology while retained for animation. |
| Tabs and search | Closing tabs preserves focus; arrow navigation skips closing DOM. Terminal Find focuses/restores correctly and clears its hidden filter. |
| Control design | Token focus rings, Kbd typography, disabled/hover/press behavior, selected-tab label motion, shared Plan/Code control, and Browser driver label swaps are consistent. |
| Status glyphs | Running-to-done/review completion plays once; existing history stays still. |
| Machines | Command/Control+Enter emits new-window intent, machine icons use their assigned hue, picked SSH hosts ignore suggestion keys, and launches respect destination focus and changes to reduced motion. |
| Shell composition | Workbench forwards wider-review state, Escape, and closed-task intent. Reduced-motion routing uses the existing CSS rules instead of generating intentional View Transition errors. |

No dependencies, lockfile, authoritative tokens, legacy application commands, or
IPC/security boundaries changed.

## Remaining design gaps

| Area | Difference from the specification | Source |
| --- | --- | --- |
| Changes review | The overview ruler and viewed-progress ring are missing. | `src/app/views/diff-review.component.html`, design `DiffReview` |
| Diff content | Loading/content swaps and expanded context do not implement all specified height easing, line fade, and scroll-preservation choreography. | `src/app/views/diff-file.component.html`, design `DiffReview` |
| Work timeline | Thread insertions/removals still lack the full grow/fade/collapse sequence. The sidebar now retains keyed rows and folds their complete occupied space, with separate reorder scopes. | `src/app/conversation/turns/work-timeline.component.html`, design Motion |
| Composer popovers | Entry animation is present; CDK picker closure still removes the panel without the designed exit animation. | `src/app/conversation/composer/agent-picker.component.html` and sibling pickers, design Presence |
| Streaming Markdown | Chat's Markdown answer path does not use the appended-chunk reveal available in standalone StreamText. | `src/app/conversation/chat/chat.component.html`, design StreamText/Motion |

The Segmented component specification explicitly says `dur-fast` /
`ease-in-out`, while the general Motion section describes spring travel. This
review retained the component-specific tokens; the design inputs need a single
answer before changing that curve globally.

## Verification scope

Validation uses the actual Angular components in native Electron, including the
isolated supplied-data preview. No capture fixture is used as product evidence.
See `VERIFICATION.md` for commands and the final capture reports. PNG inspection
checks visual states; it is not a claim of exhaustive WCAG conformance, pixel
identity, or production-scale profiling.
Packaged application and other operating systems were not tested in this review.
