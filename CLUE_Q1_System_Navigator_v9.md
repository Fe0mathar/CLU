# CLU-E Q1 System Navigator
## Physical Repository ALL Mode and File-Scoped Semantic DIVE Contract

**Document status:** permanent normative Q1 component contract  
**Revision:** 9.0 (pack-coordinated) — content of revision 2.0 preserved verbatim. Re-baselined into the coordinated v9 documentation pack; see `DOCUMENTATION_GOVERNANCE_v9.md` §14.  
**Date:** 2026-08-02  
**Target component:** `ui/system-navigator/` — CLU-E Quadrant 1  
**Normative companions:** `CLUE_Architecture_v9.md`, `CLUE_Status_Contract_v9.md`, `CLUE_Interface_Design_v9.md`, and `CLUE_Project_Directory_v9.md`  
**Primary scope:** the complete physical ALL projection, the semantic DIVE projection, their handoff, protocol, truth, performance, and acceptance rules  
**Intentionally out of scope:** current implementation assessment and file-by-file backlog  
**Language:** English  

---

## 0. Authority and use

This document is the sole detailed owner of Q1 behavior. Architecture defines where Q1 fits, Status defines the data it receives, Interface Design defines its placement in the two-tab shell, and Project Directory defines source ownership. None of those documents may independently redefine the ALL/DIVE hierarchy.

Implementations and implementation AIs must:

1. treat Sections 1–14 and 16–18 as locked product behavior;
2. preserve Q1 as a non-authoritative projection of durable backend knowledge;
3. never manufacture language, environment, semantic membership, dependency, status, or confidence in the browser;
4. validate file-count parity, identity, event replay, and protocol truth before visual polish;
5. maintain one physical file node per eligible governed file;
6. preserve explicit unknown, unsupported, partial, stale, and failed states;
7. satisfy the Definition of Done and prohibited-shortcut rules in this contract.

Current source gaps, exact file edits, and delivery ordering belong to the external dynamic backlog.

---

# 1. Executive decision

Q1 will have two clearly separated modes:

```text
ALL  = physical repository topology
DIVE = semantic architecture and code meaning
```

The new **ALL** mode is permanently locked to the file level. It shows every eligible file in the registered local repository exactly once, organized by:

```text
Project → Artifact Family → Environment → File
```

The family and environment layers are projection groups, not architectural claims. They answer:

- which technological families are present;
- which languages, runtimes, tools, platforms, or artifact environments are present;
- which physical files belong to each environment;
- how large and diverse the repository is;
- where cross-environment dependencies exist;
- which surfaces are recognized, partially recognized, unsupported, new, modified, or unresolved.

The new **DIVE** mode excludes files as visible hierarchy nodes. A file selected in ALL becomes the immutable scope context for DIVE, while the visible DIVE hierarchy begins with the broadest relevant semantic level:

```text
Domain → Subsystem → Module → Class/Type → Function/Method
```

A file may contribute to multiple domains, subsystems, or modules. DIVE must therefore support multiple semantic entry branches rather than forcing one file into one invented parent.

The core rule is:

> A file is a physical artifact. A module is a logical responsibility. They must not be treated as the same kind of hierarchy entity.

---

# 2. Locked user-facing contract

## 2.1 ALL mode purpose

ALL answers:

> What physically exists in the current governed repository, which technology family and environment does each file belong to, and how are those environments connected?

ALL does **not** attempt to explain every class, function, responsibility, or semantic module. It is the complete repository observatory and the entry surface into DIVE.

## 2.2 ALL mode visible structure

The default composition is:

```text
                              PROJECT
                    project identity / dragon
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
  ECMASCRIPT FAMILY        GPU / SHADER FAMILY       OPERATIONS FAMILY
       │                          │                          │
  ┌────┴────┐               ┌────┴────┐              ┌─────┴─────┐
 [TS]      [JS]           [WGSL]    [GLSL]          [PS]       [DOCKER]
  • • •     • • •          • • •      • •            • •        • • •
  files     files          files      files          files       files
```

The project object remains at the top of the composition. Coding families appear below it as clearly separated districts. Each family contains one or more environment anchors carrying a native or immediately recognizable programming/environment symbol. Actual repository files appear as individual file nodes around or beneath their environment anchor.

## 2.3 ALL mode is file-level only

ALL must never render these semantic entities as graph nodes:

- Domain;
- Subsystem;
- semantic Module;
- Capability;
- Responsibility;
- Class;
- Interface;
- Type;
- Function;
- Method;
- statement or symbol.

ALL may show summary counts for these in an inspector, but it may not place them into the ALL graph.

Family and environment anchors are organizational projection containers. They are not source files and are not semantic architecture units.

## 2.4 Every eligible file appears exactly once

One physical repository file produces one ALL file node.

A file must not be duplicated because it:

- contains several classes;
- implements several semantic modules;
- participates in several capabilities;
- has several runtime roles;
- is referenced by several environments;
- carries several classification facets.

Multiple logical memberships are recorded as metadata and are explored in DIVE. The ALL file node remains unique.

## 2.5 Dynamic discovery

When CLU-E discovers a new file during inventory or a later incremental run, the file appears in ALL without a page reload.

The required lifecycle is:

```text
file observed
  → file identified
  → family/environment classified
  → deterministic position assigned
  → node inserted in ALL
  → semantic recognition scheduled or attached
  → committed/unsupported/partial state displayed
```

A new file initially uses the canonical `discovered` presentation. It becomes stable only when the relevant inventory/snapshot record is committed. Unsupported files remain visible and explicitly marked unsupported; they never disappear merely because no semantic adapter exists.

## 2.6 ALL zoom behavior

ALL is semantically locked.

- Wheel zoom changes camera distance only.
- Orbit and pan change the camera only.
- Zooming in never reveals classes or functions.
- Zooming out never collapses the repository into a semantic Domain/Module view.
- Zooming does not enter or leave ALL.
- There is no configurable `overviewMaxLevel` in the final ALL contract.
- Rendering level of detail may simplify geometry and labels at distance, but it may not replace file entities with semantic entities.

This distinction is mandatory:

```text
semantic aggregation     prohibited in ALL
rendering LOD            allowed in ALL
```

## 2.7 Double-click behavior

### File node

```text
Double-click file → switch to DIVE → open semantic content scoped by that file
```

The transition must preserve the selected file identity, snapshot identity, camera continuity, and semantic membership data.

### Environment anchor

```text
Double-click environment → frame that environment inside ALL
```

It does not enter DIVE because an environment is not a file scope.

### Family district or family anchor

```text
Double-click family → frame that family inside ALL
```

### Project root

```text
Double-click project → frame the complete ALL map
```

## 2.8 DIVE file exclusion

The selected file remains visible in the DIVE context header, breadcrumb preamble, and inspector, but it is not drawn as a hierarchy node.

Example:

```text
DIVE CONTEXT
src/analysis/source/recognizer.ts
Snapshot: 9ab3…
Environment: TypeScript
Family: ECMAScript

VISIBLE SEMANTIC ROOTS
Recognition Domain
Navigator Projection Domain
Diagnostics Domain
```

Zooming out in DIVE stops at the relevant Domain roots. Domain is the broadest, least granular DIVE level. Zooming in increases semantic granularity.

## 2.9 Mode toggle

The existing top-right **DIVE / ALL** segmented control remains the only explicit top-level mode selector.

- Clicking the active side is inert.
- ALL and DIVE preserve separate camera and selection state.
- Returning from DIVE to ALL reselects and frames the originating file.
- Entering DIVE through the toggle, without a new file double-click, restores the last valid DIVE context.
- If no DIVE context exists, the UI asks the operator to select a file in ALL rather than inventing a scope.

---

# 3. Inherited design constraints

Q1 inherits these permanent CLU-E constraints:

- deterministic layout rather than unstable force physics;
- WebGPU-first rendering with bounded DOM labels;
- stable project identity and optional dragon centerpiece;
- append-only versioned event streams and replay;
- single-click inspection and hover highlighting;
- canonical lifecycle colors and source-faithful motion;
- one sealed backend snapshot identity;
- read-only projection and failure isolation;
- direction-preserving dependency aggregation;
- no browser-side scanning, classification, semantic inference, or authority;
- collision-free physical and semantic identities before exact claims;
- complete governed inventory independent of semantic adapter coverage;
- incremental insertion without global layout reconstruction.

The implementation architecture must therefore keep two distinct browser models:

```text
RepositoryInventoryModel  → ALL
SemanticGraphModel        → DIVE
```

They share durable identities and handoff mapping, but never share one containment hierarchy.

---

# 4. Target conceptual model

## 4.1 Separate physical and semantic models

Q1 should own two projections:

```text
RepositoryInventoryModel  → ALL
SemanticGraphModel        → DIVE
```

They share durable identities and selection mapping but do not share a containment hierarchy.

### RepositoryInventoryModel

Stores:

- project identity;
- taxonomy version;
- family definitions;
- environment definitions;
- one record per physical file;
- file status and classification;
- optional file-level dependency summaries;
- inventory progress and seal information.

### SemanticGraphModel

Stores:

- semantic units;
- semantic memberships;
- containment projections;
- dependency edges;
- provenance and confidence;
- file-to-unit anchor mappings;
- the current file scope for DIVE.

## 4.2 Physical file identity

Use two identities rather than one overloaded identifier.

```ts
interface FileIdentity {
  fileLocationId: string; // stable for repository + normalized path
  fileVersionId: string;  // immutable for snapshot + path + content hash
}
```

Recommended semantics:

```text
fileLocationId = hash(repositoryId + normalized relative path)
fileVersionId  = hash(snapshotId + normalized relative path + content hash)
```

`fileLocationId` supports stable UI selection across edits. `fileVersionId` binds evidence to exact bytes. A rename may later be linked with a Git-derived rename relation, but must never silently reuse the old path identity.

## 4.3 Repository file record

The backend should publish a record conceptually equivalent to:

```ts
interface RepositoryFileRecord {
  fileLocationId: string;
  fileVersionId: string;
  repositoryId: string;
  snapshotId: string;

  path: string;
  name: string;
  extension: string | null;
  bytes: number;
  contentHash: string;
  physicalFormat: string;

  familyId: string;
  environmentId: string;
  languageId: string | null;
  glyphId: string;
  facets: readonly string[];

  classification: {
    classifierVersion: string;
    source: 'creator' | 'adapter' | 'path-rule' | 'shebang' | 'extension' | 'media-type' | 'fallback';
    confidence: number;
    reason: string;
  };

  inventoryState: 'observed' | 'committed' | 'added' | 'modified' | 'removed';
  recognitionState: 'pending' | 'recognized' | 'partial' | 'unsupported' | 'failed';
  adapterId: string | null;
  adapterVersion: string | null;
  semanticDepth: string | null;

  semanticSummary: {
    domainIds: readonly string[];
    subsystemIds: readonly string[];
    moduleIds: readonly string[];
    classCount: number;
    functionCount: number;
    unresolvedCount: number;
  } | null;
}
```

The exact field names may follow existing CLU-E conventions, but the separation of physical identity, classification, recognition depth, and semantic summary is required.

## 4.4 Family definition

```ts
interface ArtifactFamilyDefinition {
  id: string;
  label: string;
  order: number;
  accentToken: string;
  patternToken: string;
  description: string;
}
```

A family is a stable presentation taxonomy, not a semantic architecture domain.

## 4.5 Environment definition

```ts
interface ArtifactEnvironmentDefinition {
  id: string;
  familyId: string;
  label: string;
  shortLabel: string;
  glyphId: string;
  order: number;
  supportedFormats: readonly string[];
  adapterId: string | null;
}
```

Examples include TypeScript, Python, PowerShell, WGSL, Docker, GitHub Actions, SQL, JSON Schema, and Markdown.

## 4.6 One primary placement, multiple facets

A file appears once in ALL under one primary family and one primary environment.

Additional roles are stored as facets:

```text
package.json
  primary family: ECMAScript
  primary environment: Node.js
  facets: configuration, package-manifest, dependency-lock-surface
```

```text
.github/workflows/ci.yml
  primary family: Build / Delivery / Cloud
  primary environment: GitHub Actions
  physical format: YAML
  facets: configuration, CI, remote-execution
```

This prevents duplicate file nodes while preserving richer truth.

---

# 5. Coding-family taxonomy

The taxonomy must be versioned, extensible, and supplied by the backend. The browser may map a `glyphId`, `accentToken`, or `patternToken` to local visual assets, but it must not independently decide which family a file belongs to.

The following initial family set is recommended.

| Family ID | Human label | Typical environments and artifacts |
|---|---|---|
| `ecmascript` | ECMAScript / Web Runtime | TypeScript, TSX, JavaScript, JSX, Node.js, Deno, Bun, package manifests, Vite configuration |
| `python` | Python Ecosystem | Python, Jupyter, pip, Poetry, `pyproject.toml`, requirements files |
| `jvm` | JVM Ecosystem | Java, Kotlin, Scala, Groovy, Maven and JVM-specific Gradle surfaces |
| `dotnet` | .NET Ecosystem | C#, F#, Visual Basic, MSBuild, `.csproj`, `.sln` |
| `native-systems` | Native Systems | C, C++, Objective-C, Assembly, headers, Make/CMake-native source surfaces |
| `modern-systems` | Modern Systems | Rust, Go, Zig, Swift and their native manifests/toolchains |
| `gpu-shader` | GPU / Shader | WGSL, GLSL, HLSL, SPIR-V metadata, CUDA/OpenCL kernels where applicable |
| `shell-automation` | Shell / Automation | PowerShell, Bash, Zsh, Windows Batch, command scripts |
| `data-query-bi` | Data / Query / BI | SQL, DAX, Power Query M, KQL, database migration and schema surfaces |
| `web-presentation` | Web Presentation | HTML, CSS, SVG, static templates and presentation-only web artifacts |
| `configuration` | Configuration / Serialization | Generic JSON, YAML, TOML, XML, INI, environment templates, generic schemas |
| `build-delivery-cloud` | Build / Delivery / Cloud | Docker, Compose, Kubernetes, Terraform, GitHub Actions, CI/CD, repository metadata, generic build files |
| `documentation` | Documentation / Knowledge | Markdown, AsciiDoc, reStructuredText, plain documentation, design and governance material |
| `binary-assets` | Binary / Media / Models | Images, audio, video, 3D models, fonts, binary blobs, packaged WebAssembly |
| `unknown` | Unknown / Unsupported | Unclassified or unsupported material artifacts |

## 5.1 Environment examples and native symbols

| Environment | Family | Preferred local glyph |
|---|---|---|
| TypeScript | ECMAScript | `TS` tile or locally packaged TypeScript mark |
| JavaScript | ECMAScript | `JS` tile |
| Node.js | ECMAScript | Node-like local glyph or `NODE` tile |
| Python | Python | local snake-style glyph or `PY` tile |
| Java | JVM | `JAVA` / `J` tile |
| Kotlin | JVM | `KT` tile |
| C# | .NET | `C#` tile |
| Rust | Modern Systems | gear/R glyph |
| Go | Modern Systems | `GO` tile |
| C | Native Systems | `C` tile |
| C++ | Native Systems | `C++` tile |
| PowerShell | Shell / Automation | terminal `>_` glyph |
| Bash | Shell / Automation | shell `$` glyph |
| Windows Batch | Shell / Automation | `CMD` tile |
| WGSL | GPU / Shader | `WGSL` tile with shader-wave treatment |
| GLSL | GPU / Shader | `GLSL` tile |
| HLSL | GPU / Shader | `HLSL` tile |
| SQL | Data / Query / BI | database cylinder + `SQL` |
| DAX | Data / Query / BI | `DAX` tile |
| Power Query M | Data / Query / BI | `M` query tile |
| HTML | Web Presentation | `</>` glyph |
| CSS | Web Presentation | CSS/braces glyph |
| JSON | Configuration | `{ }` glyph |
| YAML | Configuration | `YAML` tile |
| TOML | Configuration | `TOML` tile |
| Docker | Build / Delivery / Cloud | local container/whale-style glyph |
| GitHub Actions | Build / Delivery / Cloud | branch + check glyph |
| Kubernetes | Build / Delivery / Cloud | local wheel/cluster glyph |
| Terraform | Build / Delivery / Cloud | stacked-block glyph |
| Markdown | Documentation | `MD` or `M↓` glyph |
| Binary / Asset | Binary / Assets | cube/file glyph |
| Unknown | Unknown | broken-ring `?` glyph |

Native symbols must be shipped locally. Q1 must not depend on remote image URLs. When an official logo is not licensed or available, use a deterministic extension/environment glyph.

## 5.2 Family coding must not overwrite lifecycle coding

CLU-E already has canonical lifecycle colors:

- blue — stable / recognized / verified;
- gold — selected;
- orange — discovered / diagnosing / testing / blocked, differentiated by motion;
- green — patching.

These meanings remain authoritative.

Family identity therefore uses separate visual channels:

1. **spatial district** — primary family cue;
2. **family label** — explicit textual cue;
3. **outer ring or bezel accent** — secondary family cue;
4. **ring pattern** — non-color cue;
5. **environment glyph** — precise environment cue.

The file-node core retains lifecycle color and motion. The family accent lives outside the core.

## 5.3 Recommended family accent tokens

These are recommended starting tokens for the dark CLU-E theme. They must be treated as family accents, not state colors.

| Family | Accent | Pattern |
|---|---:|---|
| ECMAScript | `#6677CC` | double ring |
| Python | `#8BA6C9` | dotted ring |
| JVM | `#B66A61` | vertical tick ring |
| .NET | `#8F70C9` | cross-notch ring |
| Native Systems | `#9AA5B1` | solid metallic ring |
| Modern Systems | `#56AFA6` | chevron ring |
| GPU / Shader | `#B56BD1` | wave ring |
| Shell / Automation | `#71A97C` | dashed terminal ring |
| Data / Query / BI | `#4BA6A0` | segmented database ring |
| Web Presentation | `#C98265` | angle-bracket ring |
| Configuration | `#B8A15C` | braces ring |
| Build / Delivery / Cloud | `#4F8F9E` | chain-link ring |
| Documentation | `#9A87B5` | ruled-line ring |
| Binary / Assets | `#737E8F` | square-tick ring |
| Unknown / Unsupported | `#B95E70` | broken ring |

Exact tuning may be adjusted after rendering tests, but token identity and meaning must stay stable.

---

# 6. Classification rules

## 6.1 Classification precedence

The classifier uses the strongest available evidence in this order:

1. versioned Creator override;
2. registered Environment Adapter result;
3. exact filename or path rule;
4. shebang or toolchain signature;
5. extension and recognized compound extension;
6. media type or binary signature;
7. conservative fallback to `unknown`.

Every classification carries source, confidence, reason, and classifier version.

## 6.2 Important path/name overrides

The classifier must correctly handle files whose physical format is not their operational environment.

| Artifact | Physical format | Primary environment | Family |
|---|---|---|---|
| `package.json` | JSON | Node.js | ECMAScript |
| `package-lock.json` | JSON | Node.js | ECMAScript |
| `tsconfig.json` | JSON | TypeScript Toolchain | ECMAScript |
| `vite.config.ts` | TypeScript | Vite / TypeScript | ECMAScript |
| `.github/workflows/*.yml` | YAML | GitHub Actions | Build / Delivery / Cloud |
| `Dockerfile` | no extension | Docker | Build / Delivery / Cloud |
| `docker-compose.yml` / `compose.yaml` | YAML | Docker Compose | Build / Delivery / Cloud |
| `CMakeLists.txt` | no extension | CMake | Build / Delivery / Cloud or Native Systems according to policy |
| `Cargo.toml` | TOML | Rust | Modern Systems |
| `pyproject.toml` | TOML | Python | Python |
| `*.csproj` | XML | .NET / MSBuild | .NET |
| `*.sql` | SQL | SQL | Data / Query / BI |
| `*.wgsl` | WGSL | WGSL | GPU / Shader |
| `README.md` | Markdown | Markdown | Documentation |
| `*.schema.json` | JSON | JSON Schema | Configuration |

## 6.3 Unknown and unsupported files

Unknown files must be represented in a visible `UNKNOWN / UNSUPPORTED` environment under the `unknown` family.

The inspector must distinguish:

```text
UNKNOWN FORMAT
KNOWN FORMAT, NO SEMANTIC ADAPTER
ADAPTER FAILED
ADAPTER PARTIAL
INTENTIONALLY EXCLUDED
```

These are different states and must not be merged.

## 6.4 Repository inventory scope

“Every file” means every **eligible governed repository artifact**, not every transient file on disk.

Default inclusion should cover:

- tracked project files;
- newly created untracked project files under the governed inventory roots;
- root-level manifests and configuration;
- source, UI, tests, scripts, schemas, documentation, assets, CI and deployment files.

Default exclusions should cover:

- `.git` internals;
- `node_modules` and vendored dependency caches;
- `dist`, build output and generated bundles unless explicitly governed;
- CLU-E runtime workspace databases, streams and temporary artifacts;
- experiment worktrees and browser profiles;
- IDE caches;
- secret-bearing local files covered by policy;
- other explicit generated/vendor surfaces.

Excluded surfaces must be counted and inspectable through an optional `SHOW EXCLUDED / GENERATED` lens. They must not silently inflate the default file map.

---

# 7. ALL visual composition

## 7.1 Default spatial grammar

The default view must read top-to-bottom even before the operator learns the controls.

```text
upper plane     project root / dragon
middle plane    family districts
lower-middle    environment anchors
lower plane     file constellations
```

3D depth is used to separate dense file clusters, but the primary hierarchy remains visually vertical.

## 7.2 Project root

The project root:

- stays at the top center;
- may retain the existing jade dragon and singularity treatment;
- displays the registered project name;
- summarizes total eligible files, families, environments, unsupported files, and current snapshot;
- is not used as a gateway to a hidden singularity mode;
- remains visible while the complete ALL map is framed.

Selecting ALL should immediately show the complete repository map. The operator should not have to zoom through a single-point singularity to reach the map.

## 7.3 Family districts

Each family district has:

- a stable position derived from taxonomy order;
- a clear uppercase family label;
- a restrained translucent boundary, arc, or backing field;
- its family accent and pattern;
- a total file count;
- recognized, partial, unsupported, and changed counts;
- one or more environment anchors.

Family districts are visually distinct but do not become giant opaque panels. The repository remains one coherent constellation.

## 7.4 Environment anchors

Each environment anchor has:

- local native glyph;
- environment name;
- family ring;
- file count;
- adapter and semantic-depth status;
- deterministic position inside the family district;
- cluster radius based on file count;
- optional aggregate cross-environment dependency ribbons.

Environment anchor size may scale with `sqrt(fileCount)` under a strict cap.

## 7.5 File nodes

At normal distance, files read as dots. At close distance, each dot resolves into a compact micro-beveled file plate or disc.

Visual channels:

```text
core fill and motion    lifecycle state
outer bezel/ring        coding family
micro-glyph             environment
bounded radius          logarithmic file size, or fixed size if visual tests show better clarity
label                    file name, virtualized by zoom/selection
pulse                    discovery or active work
```

File size must never dominate the layout. If radius encodes bytes, use a tightly bounded logarithmic function, for example:

```text
radius scale = clamp(0.82, 1.38, 0.82 + log2(bytes + 1) × small_factor)
```

Exact bytes remain in the inspector.

## 7.6 Stable deterministic placement

No force simulation is introduced.

Recommended placement:

1. family centroids are fixed by taxonomy order;
2. environment anchors use a deterministic local ring or arc inside each family;
3. file nodes use a stable Fibonacci shell, spiral, or hashed slot around the environment anchor;
4. the slot seed is `fileLocationId`;
5. adding one file must not move every other file;
6. reclassification moves only the affected file and any resized group boundary;
7. identical inventory and taxonomy produce identical positions.

## 7.7 Label density

The graph contains every file node, but it must not display every filename simultaneously.

Recommended behavior:

- project, family, and environment labels remain visible at the default framing;
- selected and hovered file labels are always visible;
- nearby file labels appear progressively with camera distance;
- labels are collision-limited and DOM-virtualized;
- search results force labels for matched files;
- label hiding is rendering LOD, not entity removal.

## 7.8 Family and environment legend

The existing lifecycle legend remains. Add a separate compact `TECHNOLOGY` legend that can expand to show:

- family accent/pattern;
- environment glyph;
- file counts;
- unsupported count.

Do not combine lifecycle and technology meanings into one ambiguous legend.

---

# 8. Relationships in ALL

## 8.1 Default relationship policy

Displaying every file-to-file edge by default would recreate the visual noise the redesign is intended to remove.

The default ALL view should show:

- subtle project→family and family→environment containment guides;
- optional environment→file spokes at close range;
- faint aggregated environment-to-environment dependency ribbons;
- emphasized cross-family or cross-environment boundaries when evidence exists.

It should not show the complete file dependency mesh by default.

## 8.2 File focus

Hovering or selecting a file reveals:

- direct incoming file dependencies;
- direct outgoing file dependencies;
- cross-environment boundaries;
- test-of / generated-by / configures / imports relations when known;
- a compact dependency count in the inspector.

The rest of the graph dims without disappearing.

## 8.3 Relationship lens

A secondary relationship lens may provide:

```text
OFF
DIRECT (selected file, one hop)
NEIGHBORHOOD (selected file, two hops)
ENVIRONMENT AGGREGATE
CROSS-ENVIRONMENT ONLY
```

This is a lens inside ALL, not a new top-level mode.

## 8.4 No invented edge cost

Edge width may represent observed edge count. Cost, transfer overhead, risk, copy volume, or latency may be shown only when durable evidence exists. Visual design must not imply measured cost from line thickness unless that metric is actually bound.

---

# 9. Interaction contract

## 9.1 Single click

- File: select and inspect.
- Environment: select and inspect aggregate.
- Family: select and inspect aggregate.
- Project: inspect project inventory summary.

## 9.2 Double click

- File: enter DIVE with file scope.
- Environment: frame environment in ALL.
- Family: frame family in ALL.
- Project: frame complete ALL.

## 9.3 Hover

Hover shows an immediate compact label. Delayed hover opens the detailed inspector. Hovered file dependency edges are emphasized.

## 9.4 Search

Search should accept:

- filename;
- relative path;
- extension;
- family;
- environment;
- adapter status;
- recognition status;
- semantic module/domain name when available as metadata.

Search never creates a duplicate result node. It focuses the existing file.

## 9.5 Filtering

Recommended filters:

- family;
- environment;
- file extension;
- recognized / partial / unsupported / failed;
- new / modified / removed;
- tracked / untracked;
- tests;
- configuration;
- documentation;
- generated/excluded;
- cross-environment participants.

Filters alter the projection only. They never alter the inventory or recognition records.

## 9.6 ALL breadcrumb

ALL breadcrumb:

```text
PROJECT / FAMILY / ENVIRONMENT / FILE
```

Selecting a family or environment segment frames that group and remains in ALL.

## 9.7 DIVE breadcrumb

DIVE has a persistent file-context preamble followed by the semantic path:

```text
FILE: src/analysis/source/recognizer.ts
DOMAIN / SUBSYSTEM / MODULE / CLASS / METHOD
```

The file preamble is context, not a semantic breadcrumb node.

---

# 10. Dynamic update behavior

## 10.1 Initial inventory stream

Recommended stream order:

```text
navigator.reset
inventory.started
inventory.taxonomy
files.upserted (batched)
inventory.completed
recognition.started / scan.started
unit.discovered
edge.discovered
file.semantic-summary
scan.completed
graph.committing
graph.committed
```

The exact event names may align with existing conventions, but inventory and semantic recognition must remain distinguishable.

## 10.2 Batched inventory events

For repository scale, publish files in bounded batches, for example 64–256 records per event. The browser must also accept a single-file upsert for later incremental discovery.

## 10.3 New file

- insert immediately at its deterministic position;
- use discovered pulse;
- show `NEW / INVENTORY PENDING` if not yet committed;
- update family/environment counts;
- do not rebuild the entire layout;
- attach semantic summary later.

## 10.4 Modified file

- retain `fileLocationId`;
- receive a new `fileVersionId`;
- briefly show a modified halo or pulse;
- preserve selection;
- invalidate stale semantic summary until new recognition arrives.

## 10.5 Removed file

- mark as removed;
- fade or ghost for a short bounded transition;
- remove from the active inventory after the committed delta;
- preserve historical access only in a historical snapshot lens.

## 10.6 Reclassified file

- update family/environment metadata;
- animate the node to the new deterministic cluster;
- preserve physical identity and selection;
- record classification provenance and version.

## 10.7 Replay

Replaying a sealed stream must reconstruct the same:

- project counts;
- family/environment groups;
- file records;
- file positions;
- classification states;
- semantic summaries;
- selection-resolvable identities.

Cinematic discovery may be suppressed for replay, but truth must be identical.

---

# 11. ALL→DIVE handoff

## 11.1 Handoff record

Double-clicking a file creates a handoff record conceptually equivalent to:

```ts
interface DiveEntryContext {
  repositoryId: string;
  snapshotId: string;
  fileLocationId: string;
  fileVersionId: string;
  path: string;
  familyId: string;
  environmentId: string;
  semanticMembershipIds: readonly string[];
  preferredSemanticRootId: string | null;
}
```

## 11.2 DIVE scope construction

DIVE filters semantic units whose source anchors belong to the selected file, then includes their true semantic ancestors and relevant membership relations.

A file may produce several top-level branches:

```text
src/analysis/source/recognizer.ts

Recognition
  → Source Discovery
      → TypeScript Recognizer

System Navigator
  → Recognition Telemetry
      → Observer Emission

Diagnostics
  → Ambiguity Reporting
```

This is valid. The system must not force all content into one module merely because it shares one file.

## 11.3 Unit identity

A semantic unit appears as one canonical node in DIVE even when it participates in several memberships. Additional memberships use edges, alias references, or ghost references that resolve to the same durable unit ID.

Do not duplicate source-unit identity to make the layout easier.

## 11.4 Unsupported file DIVE

If a file has no semantic adapter or recognition failed, DIVE still opens a truthful scope:

```text
SEMANTIC CONTENT UNAVAILABLE
Environment: <environment>
Adapter: none / failed / partial
Physical artifact: available
Reason: <durable reason>
Next action: register adapter / retry / inspect raw artifact
```

An empty graph with no explanation is not acceptable.

## 11.5 DIVE→ALL return

Returning to ALL:

- restores the previous ALL camera;
- selects the originating file;
- frames its environment if the file is off-screen;
- optionally highlights all other files contributing to the currently selected semantic module;
- does not duplicate the file.

---

# 12. Inspector specification

## 12.1 File inspector

Required sections:

### Identity

- filename;
- relative path;
- location ID;
- version ID;
- content hash;
- snapshot ID;
- bytes;
- physical format.

### Technology classification

- coding family;
- primary environment;
- language;
- native glyph;
- facets;
- classification source;
- confidence;
- classifier version;
- reason.

### Repository state

- tracked/untracked if available;
- new/modified/removed;
- generated/vendor/excluded status;
- latest committed snapshot.

### Recognition state

- adapter;
- adapter version;
- semantic depth;
- recognized/partial/unsupported/failed;
- class/function counts;
- unresolved references;
- last recognition run and result hash.

### Semantic memberships

- all Domain memberships;
- all Subsystem memberships;
- all Module memberships;
- confidence and provenance for each;
- primary suggested DIVE root, if one exists.

### Dependencies

- inbound/outbound file counts;
- cross-environment edges;
- direct test/config/generation relations;
- unknown or unresolved relations.

### Action

- `DIVE INTO FILE`;
- `FOCUS DIRECT DEPENDENCIES`;
- `COPY PATH`;
- `OPEN EVIDENCE` where supported.

Q1 remains read-only. It must not edit or land code.

## 12.2 Environment inspector

- family;
- glyph;
- file count;
- total bytes;
- adapter coverage;
- supported/partial/unsupported counts;
- cross-environment dependencies;
- changed files;
- top file types.

## 12.3 Family inspector

- environment count;
- file count;
- coverage state;
- unsupported surfaces;
- cross-family boundaries;
- current CLU-E work in that family.

---

# 13. Performance and rendering requirements

## 13.1 No full rebuild per file event

The current deterministic layout may rebuild when the graph version changes. The new ALL model must use incremental deterministic placement.

Adding one file should update:

- one file record;
- one environment count;
- one family count;
- one deterministic slot;
- one GPU instance range;
- affected aggregate relations only.

It must not recompute all file positions.

## 13.2 GPU instancing

File nodes should use instanced rendering. Family and environment anchors may use separate instance batches because they have different geometry and glyph requirements.

Recommended instance attributes:

- position;
- radius;
- lifecycle color/state;
- family accent index;
- family pattern index;
- glyph index or environment index;
- selection/hover flags;
- discovery pulse;
- entity kind;
- stable seed.

## 13.3 Rendering LOD

At far distance:

- file nodes remain individual GPU points or tiny discs;
- micro-glyphs and labels are suppressed;
- family/environment labels remain;
- picking may require closer zoom for dense clusters.

At near distance:

- file geometry resolves;
- file glyph/extension badge appears;
- labels virtualize in;
- direct relationships become available.

## 13.4 Scale gates

The implementation should include a synthetic fixture and record results for at least:

- 100 files;
- 1,000 files;
- 10,000 files;
- 25 families/environments combined;
- 20,000 file-level relations.

Recommended target on the registered Chrome/WebGPU development profile:

- no quadratic layout operation;
- interactive orbit/zoom with 10,000 file nodes;
- no browser freeze during batched replay;
- bounded label DOM count;
- incremental insertion without full scene reconstruction;
- deterministic memory growth.

Exact frame-rate thresholds should be recorded against the actual target hardware rather than claimed without measurement.

---

# 14. Protocol and truth requirements

## 14.1 Inventory is authoritative for ALL membership

A file exists in ALL because the committed inventory says it exists, not because the semantic recognizer happened to emit a function.

## 14.2 Recognition enriches; it does not create physical files

`unit.discovered` and `edge.discovered` attach semantic information to existing file identities. If an event references a file absent from the inventory, the UI records a projection error and does not silently invent a file.

## 14.3 Classification is backend-owned

The browser may display a conservative fallback glyph if `glyphId` is unknown, but it must not recalculate family or environment from the extension.

## 14.4 Explicit unknowns

All unknown, unsupported, partial, stale, or failed states remain explicit. No missing field is rendered as a confident classification.

## 14.5 Versioning and seals

The Navigator stream should bind:

- stream schema version;
- taxonomy version/hash;
- repository inventory hash;
- snapshot/capture identity;
- recognition run identity;
- durable result hash;
- committed unit/edge counts;
- inventory file/family/environment counts.

## 14.6 Idempotency

Repeated `file.upsert` events with the same file version must not duplicate nodes. Out-of-order or stale version events must be rejected or explicitly reconciled.

## 14.7 Projection boundary

Q1 does not:

- scan the filesystem independently;
- classify languages independently;
- infer semantic modules independently;
- create dependencies;
- prove improvement;
- mutate source;
- apply patches;
- land Git changes.

---

# 15. Stable implementation ownership

The permanent ownership model is:

| Responsibility | Owning area |
|---|---|
| artifact-family and environment taxonomy | backend environment registry under `src/analysis/environments/` |
| conservative classification and physical inventory | `src/analysis/source/` and environment registry |
| inventory and semantic event protocol | backend Navigator projection and shared schemas |
| ALL repository state | `ui/system-navigator/src/core/RepositoryModel.js` or equivalent |
| deterministic ALL layout | dedicated ALL layout engine |
| ALL frame construction and relationship lenses | dedicated ALL frame builder |
| local environment glyphs | Q1 UI glyph registry |
| independent ALL/DIVE cameras and handoff | Navigator mode-state component |
| DIVE semantic graph | semantic graph model and semantic layout engine |
| WebGPU rendering and picking | Q1 render layer |
| interaction, HUD, inspector, styles | dedicated Q1 input/UI modules |
| SSE/replay and completed-result adaptation | Q1 adapters |
| custom-element public API | System Navigator element |
| mixed-language, scale, replay, and interaction tests | Q1 test and verification tooling |
| Dashboard integration | four-quadrant shell consuming the same sealed status |

Exact file-by-file work items, current code mismatches, and current completion state are maintained in `CLU-E_Backlog_and_Program_Integrity_v8.md`, outside the permanent documentation archive. Source placement and target filenames are owned by `CLUE_Project_Directory_v9.md`.

---

# 16. Required test fixtures

Q1 conformance testing must create or use a mixed repository fixture containing at least:

```text
src/app.ts
src/legacy.js
python/tool.py
scripts/build.ps1
scripts/start.bat
shaders/main.wgsl
shaders/fallback.glsl
data/schema.sql
bi/measure.dax
web/index.html
web/app.css
config/app.json
config/service.yaml
.github/workflows/ci.yml
Dockerfile
compose.yaml
package.json
tsconfig.json
README.md
assets/scene.glb
mystery/custom.xyz
```

It should also include:

- two files with the same filename under different paths;
- one no-extension script with a shebang;
- one generated file excluded by policy;
- one unsupported material artifact;
- one file containing several semantic modules;
- one semantic module spanning several files;
- one file that changes environment after a path/name change;
- one file removed during incremental replay.

---

# 17. Definition of done

The improvement is complete only when all conditions below are met.

## 17.1 Structural correctness

- ALL contains one project root.
- ALL contains family districts and environment anchors.
- ALL contains one node per eligible physical file.
- ALL contains no Domain, Subsystem, semantic Module, Class, Function, or Method node.
- DIVE contains no visible File node.
- DIVE zoom-out stops at relevant Domain roots.
- One file may lead to several DIVE semantic branches.

## 17.2 Classification correctness

- Every file has one primary family and environment or explicit unknown.
- Native environment identity is visible.
- Family coding is visible independently from lifecycle state.
- Classification provenance, confidence, and version are inspectable.
- Operational environment overrides physical format where evidence supports it.

## 17.3 Inventory correctness

- ALL file count equals the governed repository inventory count.
- Unsupported files are visible.
- Root-level files are visible.
- Runtime, dependencies, caches, and excluded/generated bulk are absent by default and explicitly counted.
- No semantic unit event can silently create a physical file.

## 17.4 Dynamic correctness

- New file appears without reload.
- Modified file retains location identity and gets a new version identity.
- Removed file is handled explicitly.
- Reclassified file moves to the correct group.
- Replay produces the same state.

## 17.5 Interaction correctness

- File double-click enters DIVE.
- Family/environment double-click remains in ALL.
- Zoom in ALL never changes semantic level or mode.
- ALL and DIVE preserve separate cameras.
- DIVE→ALL restores the originating file.
- Search and filters operate on existing nodes, not duplicates.

## 17.6 Visual correctness

- Project is clearly at the top.
- Families are clearly grouped below it.
- Environments have recognizable local symbols.
- Files are readable as dots at normal scale.
- Technology family and lifecycle meanings cannot be confused.
- Unknown/unsupported state is visible.
- Default file dependency mesh is not visually overwhelming.

## 17.7 Performance correctness

- No O(N²) global layout for ordinary insertion.
- 10,000-file synthetic fixture remains interactive on the registered test profile.
- Labels are virtualized.
- GPU buffers update incrementally.
- One file event does not rebuild the whole scene.

## 17.8 Truth and evidence correctness

- Inventory, taxonomy, snapshot, run, and result identities are bound in the stream/seal.
- Browser classification is prohibited.
- Unknown values remain unknown.
- Q1 remains read-only and non-authoritative.
- All new tests and the Q1 verifier pass.
- Documentation and directory maps are synchronized.

---

# 18. Prohibited shortcuts

The implementation must not:

- keep the current path-derived Domain/Subsystem/Module hierarchy inside ALL and merely recolor it;
- treat a file extension as sufficient environment truth when a stronger path/toolchain rule exists;
- hide unsupported files;
- duplicate one file under several modules or environments;
- use family color as the node’s lifecycle color;
- make the browser the classification authority;
- derive physical file existence from TypeScript units;
- show all file dependency edges by default;
- use zoom as a hidden mode switch in ALL;
- retain File as a visible DIVE semantic level;
- add family/environment to DIVE granularity enums;
- introduce an unstable force layout;
- re-layout every node after one file insertion;
- fetch native symbols from the internet at runtime;
- claim semantic support where only inventory support exists;
- silently accept duplicate unit identities or dangling internal edges;
- expand the already large `SystemNavigator.js` with all new model/layout logic instead of extracting responsibilities;
- update code without updating the normative Q1 documentation and tests.

---

# 19. Conformance dependency sequence

A conforming implementation establishes the Q1 contract in this dependency order:

```text
1. Lock the physical/semantic contract and taxonomy.
2. Prove conservative classification and complete inventory identity.
3. Prove durable inventory events, seals, and replay.
4. Build the browser RepositoryInventoryModel.
5. Prove deterministic incremental ALL placement.
6. Render family/environment/file channels separately from lifecycle state.
7. Implement exact mode state and file-only ALL→DIVE handoff.
8. Remove File as a visible DIVE semantic level.
9. Add inspectors, search, filters, relationship lenses, and accessibility.
10. Prove mixed-language, unknown/unsupported, dynamic update, and scale behavior.
11. Integrate with Status v5 and the four-quadrant shell.
```

This sequence is a conformance dependency, not a current sprint plan.

---

# 20. Final design statement

The improved Q1 should communicate the repository in two complementary truths:

```text
ALL
Where are the physical artifacts, what technology families and environments do they belong to, and which file should I inspect?

DIVE
What does the selected physical artifact contribute to the project’s semantic architecture, and how do its classes, functions, dependencies, and responsibilities behave?
```

This separation preserves completeness without visual chaos.

ALL becomes a truthful live map of the complete polyglot repository. DIVE becomes a focused semantic explanation surface. A file can participate in many logical structures without being duplicated, and a technology can be recognized as part of a broader coding family without sacrificing its native identity.

That is the correct foundation for eventually supporting all programming languages and execution environments through CLU-E’s Environment Adapter Registry and Universal Project Representation.
