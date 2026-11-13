# Third-party notices

Session Dashboard adapts code and assets from the projects below. Files that adapt code start with a header
`// Adapted from <owner/repo>@<sha>:<path> (<SPDX>). Modified for session-dashboard.` (Apache-2.0 §4(b): modified files are marked).
Code from copyleft or source-available projects (GPL/AGPL/SUL/PolyForm) was used for ideas only and is not included.

## Adapted source code and assets

| Project | Repository | Commit | License | Copyright | Used for |
|---|---|---|---|---|---|
| create-tauri-ui | https://github.com/agmmnn/tauri-ui | 1.2.1 (npm) | MIT | Copyright (c) agmmnn | Project scaffold, desktop defaults, debug panel (src/components/debug-panel.tsx, external-link-guard.tsx, lib/tauri.ts) |
| shadcn/ui | https://github.com/shadcn-ui/ui | CLI 4.23.0 | MIT | Copyright (c) 2023 shadcn | src/components/ui/* (restyled) |
| Radix Colors | https://github.com/radix-ui/colors | — | MIT | Copyright (c) 2022 WorkOS | Design tokens: slateDark + status scales (src/styles/tokens.css), community colors |
| VS Code themes | https://github.com/microsoft/vscode | — | MIT | Copyright (c) 2015 - present Microsoft Corporation | Diff gutter colors (Dark Modern), density references |
| Orca | https://github.com/stablyai/orca | 3bb91aa | MIT | Copyright (c) 2026 Lovecast Inc. | StatusGlyph (AgentStateDot), toast stack behavior, status bar, inspector layout |
| Yaak | https://github.com/mountain-loop/yaak | 6a34d0a | MIT | Copyright (c) 2024 Yaak | WindowControls, titlebar per OS, settings rows/sections, EmptyState |
| Trigger.dev | https://github.com/triggerdotdev/trigger.dev | 2fbd5c7 | Apache-2.0 | Copyright Trigger.dev contributors | PropertyTable, tree/side-menu patterns, type scale |
| Langfuse (outside ee/) | https://github.com/langfuse/langfuse | 48a3181 | MIT | Copyright (c) 2023-2026 ClickHouse, Inc. | Sessions table mechanics (CSS-variable column widths, sort cycle) |
| Agent of Empires | https://github.com/agent-of-empires/agent-of-empires | d134cfd | MIT | Copyright (c) 2026 Nathan Brake | Attention tiers, sidebar row model, approval/question card patterns |
| Jean | https://github.com/coollabsio/jean | 1d53d3c | Apache-2.0 | Copyright coollabsio contributors | Settings section/row structure, session settings fields; review screen (GitDiffModal comment bar, file tree, memoized diffs) |
| Vibe Kanban | https://github.com/BloopAI/vibe-kanban | 5f06193 | Apache-2.0 | Copyright BloopAI contributors | RepoCard/GitPanel patterns, conversation virtualizer, tool summaries, approval entry |
| Crystal | https://github.com/stravu/crystal | 1e18e0b | MIT | Copyright (c) 2024 Stravu | ProjectDashboard worktree table, GitStatus model |
| Nimbalyst | https://github.com/nimbalyst/nimbalyst | ab6a549 | MIT | Copyright (c) 2024-2026 Nimbalyst Inc. | Session schema ideas, canvas card LOD |
| claude-code-viewer | https://github.com/d-kimuson/claude-code-viewer | 9367cf0 | MIT | Copyright (c) 2025 Claude Code Viewer | JSONL entry schema reference |
| Emdash | https://github.com/generalaction/emdash | ccc6cce | Apache-2.0 | Copyright 2026 General Action, Inc. | Notification coalescing model, Session vs Conversation glossary |
| Cline | https://github.com/cline/cline | 72b3d71 | Apache-2.0 | Copyright Cline Bot Inc. and contributors | Tool activity/work blocks, approval card, composer, prompt queue, changes panel, terminal panel wiring; review screen (changes panel, tool diff) |
| T3 Code | https://github.com/pingdotgg/t3code | be5f805 | MIT | Copyright (c) 2026 T3 Tools Inc. | Timeline, work log, pending approval row, composer menu; review screen (DiffPanel, worker pool readiness) |
| Vercel AI Elements | https://github.com/vercel/ai-elements | ca8be60 | Apache-2.0 | Copyright 2023 Vercel, Inc. | Queue/plan/confirmation component patterns |
| Headlamp | https://github.com/kubernetes-sigs/headlamp | e16a575 | Apache-2.0 | Copyright The Kubernetes Authors | Map architecture: id-only nodes, group nodes, layout cache |
| Argo CD | https://github.com/argoproj/argo-cd | ae2e784 | Apache-2.0 | Copyright The Argo Authors | Resource-tree card anatomy, collapsed sibling groups, update flash |
| Dagster | https://github.com/dagster-io/dagster | 56029e3 | Apache-2.0 | Copyright Dagster Labs | Graph level-of-detail thresholds |
| React Flow / React Flow UI | https://github.com/xyflow/xyflow | @xyflow/react 12.12.1 | MIT | Copyright (c) 2019-2025 webkid GmbH | Agent map canvas; src/components/flow/* (React Flow UI components) |
| xyflow examples (contextual zoom, simple floating edges) | https://example-apps.xyflow.com | fetched 2026-11-14 | MIT | Copyright (c) 2019-2025 webkid GmbH | Map LOD selector pattern, floating link edges (src/features/map) |
| shadcn/ui slider (radix-nova) | https://github.com/shadcn-ui/ui | registry 2026-11-14 | MIT | Copyright (c) 2023 shadcn | src/components/flow/slider.tsx (zoom slider) |
| LightRAG WebUI | https://github.com/HKUDS/LightRAG | 377cd24 | MIT | Copyright (c) 2025 LightRAG Team | Code graph viewer patterns (FA2 worker budget, highlight reducers, search/focus) |
| Graphify | https://github.com/Graphify-Labs/graphify | v8 | Apache-2.0 | Copyright Graphify Labs | graph.json format; src/mocks/fixtures/httpx-graph.json (unmodified example graph) |

## Runtime dependencies (npm, unmodified)

| Package | License |
|---|---|
| @xyflow/react | MIT |
| @dagrejs/dagre | MIT |
| sigma, graphology, graphology-layout-forceatlas2, @react-sigma/core | MIT |
| @pierre/diffs | Apache-2.0 |
| streamdown, @streamdown/code | Apache-2.0 |
| shiki | MIT |
| @xterm/xterm + addons | MIT |
| @tanstack/react-router, react-table, react-virtual | MIT |
| zustand | MIT |
| cmdk | MIT |
| tinykeys | MIT |
| react-resizable-panels | MIT |
| radix-ui | MIT |
| lucide-react | ISC |
| @tauri-apps/* (api, plugins) | MIT OR Apache-2.0 |
| @fontsource-variable/ibm-plex-sans (IBM Plex Sans) | OFL-1.1 |
| @fontsource-variable/jetbrains-mono (JetBrains Mono) | OFL-1.1 |

Fonts are distributed under the SIL Open Font License 1.1 (https://openfontlicense.org); the license texts ship inside the @fontsource packages.

## MIT License (applies to the MIT projects above, with their copyright lines)

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC License (Lucide)

```
Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.
```

## Apache License 2.0 (applies to the Apache-2.0 projects above)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction,
    and distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by
    the copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all
    other entities that control, are controlled by, or are under common
    control with that entity. For the purposes of this definition,
    "control" means (i) the power, direct or indirect, to cause the
    direction or management of such entity, whether by contract or
    otherwise, or (ii) ownership of fifty percent (50%) or more of the
    outstanding shares, or (iii) beneficial ownership of such entity.

    "You" (or "Your") shall mean an individual or Legal Entity
    exercising permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation
    source, and configuration files.

    "Object" form shall mean any form resulting from mechanical
    transformation or translation of a Source form, including but
    not limited to compiled object code, generated documentation,
    and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or
    Object form, made available under the License, as indicated by a
    copyright notice that is included in or attached to the work
    (an example is provided in the Appendix below).

    "Derivative Works" shall mean any work, whether in Source or Object
    form, that is based on (or derived from) the Work and for which the
    editorial revisions, annotations, elaborations, or other modifications
    represent, as a whole, an original work of authorship. For the purposes
    of this License, Derivative Works shall not include works that remain
    separable from, or merely link (or bind by name) to the interfaces of,
    the Work and Derivative Works thereof.

    "Contribution" shall mean any work of authorship, including
    the original version of the Work and any modifications or additions
    to that Work or Derivative Works thereof, that is intentionally
    submitted to Licensor for inclusion in the Work by the copyright owner
    or by an individual or Legal Entity authorized to submit on behalf of
    the copyright owner. For the purposes of this definition, "submitted"
    means any form of electronic, verbal, or written communication sent
    to the Licensor or its representatives, including but not limited to
    communication on electronic mailing lists, source code control systems,
    and issue tracking systems that are managed by, or on behalf of, the
    Licensor for the purpose of discussing and improving the Work, but
    excluding communication that is conspicuously marked or otherwise
    designated in writing by the copyright owner as "Not a Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity
    on behalf of whom a Contribution has been received by Licensor and
    subsequently incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of
    this License, each Contributor hereby grants to You a perpetual,
    worldwide, non-exclusive, no-charge, royalty-free, irrevocable
    copyright license to reproduce, prepare Derivative Works of,
    publicly display, publicly perform, sublicense, and distribute the
    Work and such Derivative Works in Source or Object form.

3.  Grant of Patent License. Subject to the terms and conditions of
    this License, each Contributor hereby grants to You a perpetual,
    worldwide, non-exclusive, no-charge, royalty-free, irrevocable
    (except as stated in this section) patent license to make, have made,
    use, offer to sell, sell, import, and otherwise transfer the Work,
    where such license applies only to those patent claims licensable
    by such Contributor that are necessarily infringed by their
    Contribution(s) alone or by combination of their Contribution(s)
    with the Work to which such Contribution(s) was submitted. If You
    institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work
    or a Contribution incorporated within the Work constitutes direct
    or contributory patent infringement, then any patent licenses
    granted to You under this License for that Work shall terminate
    as of the date such litigation is filed.

4.  Redistribution. You may reproduce and distribute copies of the
    Work or Derivative Works thereof in any medium, with or without
    modifications, and in Source or Object form, provided that You
    meet the following conditions:

    (a) You must give any other recipients of the Work or
    Derivative Works a copy of this License; and

    (b) You must cause any modified files to carry prominent notices
    stating that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works
    that You distribute, all copyright, patent, trademark, and
    attribution notices from the Source form of the Work,
    excluding those notices that do not pertain to any part of
    the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its
    distribution, then any Derivative Works that You distribute must
    include a readable copy of the attribution notices contained
    within such NOTICE file, excluding those notices that do not
    pertain to any part of the Derivative Works, in at least one
    of the following places: within a NOTICE text file distributed
    as part of the Derivative Works; within the Source form or
    documentation, if provided along with the Derivative Works; or,
    within a display generated by the Derivative Works, if and
    wherever such third-party notices normally appear. The contents
    of the NOTICE file are for informational purposes only and
    do not modify the License. You may add Your own attribution
    notices within Derivative Works that You distribute, alongside
    or as an addendum to the NOTICE text from the Work, provided
    that such additional attribution notices cannot be construed
    as modifying the License.

    You may add Your own copyright statement to Your modifications and
    may provide additional or different license terms and conditions
    for use, reproduction, or distribution of Your modifications, or
    for any such Derivative Works as a whole, provided Your use,
    reproduction, and distribution of the Work otherwise complies with
    the conditions stated in this License.

5.  Submission of Contributions. Unless You explicitly state otherwise,
    any Contribution intentionally submitted for inclusion in the Work
    by You to the Licensor shall be under the terms and conditions of
    this License, without any additional terms or conditions.
    Notwithstanding the above, nothing herein shall supersede or modify
    the terms of any separate license agreement you may have executed
    with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade
    names, trademarks, service marks, or product names of the Licensor,
    except as required for reasonable and customary use in describing the
    origin of the Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or
    agreed to in writing, Licensor provides the Work (and each
    Contributor provides its Contributions) on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
    implied, including, without limitation, any warranties or conditions
    of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
    PARTICULAR PURPOSE. You are solely responsible for determining the
    appropriateness of using or redistributing the Work and assume any
    risks associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory,
    whether in tort (including negligence), contract, or otherwise,
    unless required by applicable law (such as deliberate and grossly
    negligent acts) or agreed to in writing, shall any Contributor be
    liable to You for damages, including any direct, indirect, special,
    incidental, or consequential damages of any character arising as a
    result of this License or out of the use or inability to use the
    Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all
    other commercial damages or losses), even if such Contributor
    has been advised of the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing
    the Work or Derivative Works thereof, You may choose to offer,
    and charge a fee for, acceptance of support, warranty, indemnity,
    or other liability obligations and/or rights consistent with this
    License. However, in accepting such obligations, You may act only
    on Your own behalf and on Your sole responsibility, not on behalf
    of any other Contributor, and only if You agree to indemnify,
    defend, and hold each Contributor harmless for any liability
    incurred by, or claims asserted against, such Contributor by reason
    of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```
