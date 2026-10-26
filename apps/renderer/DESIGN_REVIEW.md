# Component design review

## Machine editing and removal, 2026-10-26

The updated MachineMenu/EditMachine specifications are implemented in Angular
and integrated with production Home. Menus occupy the tag's place, share mouse
and keyboard actions, and preserve their card origin for the modal morph.
Appearance edits keep connections alive; destination/sign-in changes prepare on
the card. Removal retains the inert card for its fade, slides neighbours after
it, and offers a window-owned Undo that preserves ID/order without reconnecting.
Occupied removal returns affected windows to Home. Local machines have no Remove.

The new desktop continues to use native OpenSSH configuration and trust. It has
no independent application-pinned host key, so removal leaves the user's
known_hosts untouched and its confirmation names the card and connection.
Peer transport remains unavailable; the reusable components support peer metadata
and Edit/Unpair presentation. New native captures cover themes, focused/context
menus, precise removal movement, anchored dialogs, focus after removing the
opener, narrow layouts and reduced motion; see VERIFICATION.md.

## Project and machine design update, 2026-10-26

The updated archive's three flows are ported to Angular. Later projects open
from the rail's actual + tile; Create clears that origin for a plain retained
exit while the new selected mark springs/rings and existing tiles glide. The
first project retains its separate jumpHome sequence. The project preview now
recreates NewTask by project identity when switching projects.

Machine preparation errors live on their cards with the full attention/danger
tokens, stopped progress and one accessible action; danger is reserved for host
trust. Busy-to-error nudges once; existing errors and reduced motion stay still.
The production launcher retains observed server errors through machine changes
until the destination starts preparing again or becomes ready.

Home's title island prioritizes errors and preparation, pointing at the relevant
card. Back reopens the held machine; Machines opens Find, or points at the local
card on first run. In-workspace island clicks still open the machine panel. The
production owner and isolated flow preview share the Home status wording.
See [verification](VERIFICATION.md) for native reports and the existing project
adapter limitation.

## Production machine integration, 2026-10-25

First launch and later machine Home now share one production composition over the
existing components and real lifecycle IPC. The first-run look ends only after a
ready machine opens. Pending launch uses the last selection, cancels on navigation
or failure, and waits for both card readiness and the matching backend scope.
Other windows' saved-host presence is visible without exposing their challenges
or drafts. Modal recession includes the title bar; machine workspace identity
changes remount feature state while updates and returning Home preserve it.

The real SSH adapter saves the destination and delegates trust/authentication to
OpenSSH. Its actual expiring fingerprint prompt uses HostKeyCheck in the same
challenge flow used for reconnects. An already trusted host needs no redundant
trust step. Suggestions cover explicit top-level SSH aliases; Includes are still
resolved by OpenSSH when a host is typed directly. Inherited user/port values are
described as coming from config rather than guessed.

Peer transport and the desktop project adapter remain unimplemented. Pairing
explains this limitation; NewProject renders the designed landing with disabled
controls and a clear availability note. These are recorded gaps, not completed
platform integrations. No generic networking, secrets storage or renderer debug
capabilities were added. See [verification](VERIFICATION.md).

## Preparation title-island spacing, 2026-10-25

Corrected the machine-flow composition: preparation and updating use compact
icon/text content rather than the padded rich-event component. The previous 48px
surface overflowed the title bar; the reference is a 24px pill in a 34px bar, with
12px horizontal padding, a 7px gap and a 13px icon. Identical-text native measurements
now match the supplied reference exactly in both themes (200×24px, centered, 5px
above/below). Rich events retain their separate tall layout. The status derives
from current machine progress and keeps its content key stable through progress
and preparation-step changes. See [verification](VERIFICATION.md) for native images
and regression results.

## Machine flows in the latest ZIP, 2026-10-24

Implemented the current machine model directly: first-run Home with dashed add
cards, preparation/progress on machine cards, pending selection, a shared SSH/pair
AddMachine dialog, trigger-origin ModalLayer motion, and launch onto NewProject.
RunChoice source, styles, template, barrel export and imported specification were
removed. The old host-trust and pairing action footers were removed; AddMachine
owns confirmation/navigation and emits a discriminated intent. Changed-key typed
confirmation remains required and is invalidated when identity changes.

Presentation remains separate from operations. MachineHome owns keyed placement,
filtering and scoped grid motion; stable keys avoid geometry scans for progress-only
updates. MachineLaunchComponent owns activity/focus and its scoped Home context;
MachineLaunchMotion owns unscaled geometry, cloned faces, interruption and cleanup.
The animated view owns its inactive state directly. Preview orchestration alone
owns abortable lookup examples, preparation and pending-launch timers, with a
separate mounted project view for each machine identity.

AutoHeight and EaseSwap now measure logical sizes through ancestor scale, ignore
observations after disposal/detachment and seed the first attached size without
animating from zero. Modal motion restores the projected surface's original
transform origin when disposed. This also removes a source of blank/clipped labels
and drifting modal anchors in the previous component update.

The live reference and Angular dialogs are 460px wide on a normal desktop, with
172.5×128px machine cards in the 720px reference grid. Both light/dark native modal
origin probes measured the trigger center exactly (0px delta). Launch faces begin
within 1px of the visible card, view scaling stays uniform, and interrupted clips
remain within 1px in both directions. Full normal-timeline flows and focus reuse
are checked separately from frozen surface probes. Native control affordances
(typing, textarea editing, focus rings and changed-key confirmation) remain real
semantic controls. Fractional font/layout rounding is not treated as pixel identity.

[Verification](VERIFICATION.md) records the 150 renderer tests, runtime/type checks,
116 native product checkpoints and four supplied-reference captures. No dependencies,
tokens, legacy-app behavior or privileged IPC boundaries changed. This review covers
the changed machine families and shared motion fixes; earlier unrelated design gaps
below are historical and were not silently claimed as resolved.

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
