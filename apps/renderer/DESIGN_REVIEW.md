# Component design review

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
| Counts | Project badges update directly rather than using the specified count roll/pop. | `src/app/tasks/projects/project-rail.component.html`, design Motion |

The Segmented component specification explicitly says `dur-fast` /
`ease-in-out`, while the general Motion section describes spring travel. This
review retained the component-specific tokens; the design inputs need a single
answer before changing that curve globally.

## Verification scope

Validation uses the actual Angular components in native Electron, including the
isolated supplied-data preview. No capture fixture is used as product evidence.
See `VERIFICATION.md` for commands and the final capture reports. PNG inspection
checks visual states; it is not a claim of exhaustive WCAG conformance, pixel
identity with an unavailable reference renderer, or production-scale profiling.
Packaged application and other operating systems were not tested in this review.
