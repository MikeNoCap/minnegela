# Minnegela — Technical Design Document

*A search engine for your friend group's memories.*

Version 0.2 · 2026-09-07 · Status: proposal, no code written yet. v0.2 adds presence-gated visibility (§18.3) and Cloudflare R2 object storage (§15).

---

## 0. Decisions at a glance

| Area | Recommendation | Rejected alternatives (and why) |
|---|---|---|
| ML placement | **Hybrid, server-heavy.** Phone does metadata, hashing, preview generation, upload scheduling. Server does every neural model. | Full client-side ML: no cross-user clustering possible on a phone, battery cost, iOS background limits, two ML stacks to maintain. Full server-side: forces uploading full originals before anything works. |
| Face recognition | **InsightFace SCRFD detector + ArcFace (buffalo_l) embeddings**, cosine matching against per-person prototype sets, human-in-the-loop labelling. No training. | Training a network (no data, no need). Cloud face APIs (privacy, cost, lock-in). |
| Image understanding | **OpenCLIP ViT-B/16** image embeddings (512-d) + zero-shot content tags derived from the same embedding. | Object detectors / captioning models (more compute, less useful for "same event?" than an embedding). |
| Event clustering | **Time-ordered change-point segmentation over the group timeline, with a windowed multi-signal boundary score, followed by a spatial split for concurrent activity.** | DBSCAN/HDBSCAN on time×space (ignores people/visual/contributor signals and chains badly), graph + connected components (chaining, harder to explain and to edit). |
| Database | **PostgreSQL 16 + pgvector + pg_trgm + PostGIS-lite (earthdistance).** One database for everything. | Elasticsearch/OpenSearch, Pinecone/Qdrant/Milvus: unnecessary below ~5M vectors. |
| Object storage | **Cloudflare R2** from Phase 2 onward, via `@aws-sdk/client-s3` and presigned URLs; **MinIO** only for local development and Phase 0–1, same client, different endpoint. | Self-hosted MinIO in production (the home uplink becomes the bottleneck when several people scroll grids and video). Bare filesystem (no presigned URLs). |
| Visibility | **Presence-gated.** An event is visible to a member only if they contributed to it, are recognized or tagged in it, or a contributor opened it to the group. Solo moments and utility media are never visible to anyone but the owner. Enforced in SQL on every fetch, with row-level security as a backstop. | Group-wide visibility with per-member share scopes (too much to explain, too easy to get wrong, and it makes people hesitate to install). |
| Queue | **Postgres jobs table with `FOR UPDATE SKIP LOCKED`.** Node and Python workers consume the same table. | BullMQ/Redis (extra service, two client libraries), RabbitMQ (overkill). |
| API | **Fastify + Zod + Drizzle ORM**, REST/JSON, thin generated TypeScript client shared by web and mobile. | tRPC (nice, but Python workers and presigned uploads live outside it anyway), Next.js API routes (couples API to web). |
| Web | **Next.js (App Router)**, Tailwind, TanStack Query, MapLibre. | — |
| Mobile | **Expo (dev client, not Expo Go)** with expo-media-library, expo-background-task, expo-file-system background uploads; one small custom native module later. | Bare RN (loses Expo tooling), Flutter/native (two codebases, not your stack). |
| ML runtime | **Python worker**: onnxruntime-gpu for InsightFace, PyTorch (pinned Pascal-compatible wheel) for OpenCLIP. fp32 only. | Serving models over HTTP (extra hop, no batching benefit). |
| Auth | **Better Auth** (email + magic link/passkey), Expo plugin, opaque session tokens for mobile. | Rolling your own (session bugs), Auth.js (weak native story). |
| Networking | **Tailscale** for phases 0–2. Caddy + public domain only when needed. | Public exposure from day one (attack surface for a box holding faces and locations). |
| Search | **Structured query parser** (people, dates, places, event titles) + **CLIP text-to-image ranking** for the remainder. No LLM in the query path for v1. | LLM query parsing (latency, cost, nondeterminism; revisit in phase 3). |

---

## 1. Product thesis

Everyone in a friend group carries a partial, disconnected record of the group's shared life. Each phone has a different subset of the same nights, trips and dinners. Nobody can find anything, because the record is fragmented across devices and because most of the interesting photos have nothing searchable in them: a table, a doorway, a blurry ceiling, a 9-second video.

Minnegela's thesis: **the unit of memory is the event, not the photo.** A photo is evidence about an event. Faces, timestamps, GPS, visual content and the other photos around it are all evidence. Once the system reconstructs the event, every photo inside it becomes findable by any attribute of the event, including attributes the photo itself does not carry.

The table photo at 23:47 becomes findable by "Emma" because Emma was at the event, not because she is in the picture.

This inverts the usual photo-app architecture. Google Photos and Apple Photos organize one person's library and treat faces as the primary index. We organize a group's shared timeline and treat context as the primary index. The face recognizer is a component. The event reconstructor is the product.

Three consequences drive every design decision below:

1. **Cross-user is not a feature; it is the substrate.** Clustering runs over the group's pooled timeline. A single-user version is just a group of one.
2. **Faceless media is first-class.** Every model and threshold must be evaluated on "did the table photo land in the party?" and not only on face accuracy.
3. **Uncertainty is shown, not hidden.** The system says "probably part of this night" and makes correction a one-tap action. That makes the AI feel honest instead of wrong.
4. **You only see what you were part of.** Being at an event, as a photographer or as a face in someone's photo, is the key that unlocks it. Nothing else in a member's library is ever visible to the group. This is what makes it acceptable for the app to index a whole camera roll.

## 2. Core user experience

### 2.1 The killer flow

1. Mikkel opens the web app six months after a party. Types "Emma and Jonas" or "party in March".
2. Result: one event card. *"Friday night — Grünerløkka, Oslo · 14 March · 21:30–03:12 · 315 photos and videos · 4 contributors · 8 people."*
3. He opens it and scrolls a reconstructed timeline of the night: arrival photos, drinks on the table, the guitar video, the street outside at 00:02, the shoes, the group selfie at 01:14, leaving at 03:02. Media from all four phones interleaved by time, with a small avatar showing whose phone each came from.
4. Photos the system is less sure about (the shoes, the ceiling) sit in the same timeline but carry a quiet "probably" chip. One tap removes one or confirms it.
5. He can filter the event to "just Emma", "just videos", "just the aesthetic stuff", or jump to the map.

### 2.2 Everyday flows

- **Timeline browsing.** The home page is a reverse-chronological river of events, each a card with a cover mosaic, people avatars, contributors, place and counts. Days with only stray photos collapse into "12 loose photos".
- **People.** A person page shows their events, co-appearance graph ("most often with Emma, Jonas"), and photos. Multi-person queries are a first-class filter chip interaction, not a search-syntax trick.
- **Places.** Named places (auto-clustered, user-renamed: "Emma's place", "Blå", "the cabin") with the events that happened there.
- **Search.** One box that accepts free text and turns it into visible filter chips so the user can see how the query was understood and fix it.
- **Correction.** Merge two events by drag, split an event at a timeline gap, rename, exclude a photo, confirm or reject a face. Every correction is remembered as a constraint and survives re-clustering.
- **Presence, not permission settings.** A member never configures who sees what. They see the events they were at; everyone else sees nothing of theirs. A contributor can open one event to the whole group with a single toggle ("Show this trip to everyone"). Confirming a friend's face in the review queue is also what lets that friend see the night.

### 2.3 Mobile app role

The phone app is a **sync client with a privacy dashboard**, not the browsing surface. It shows: what has been indexed, what is queued, what is excluded, who can see what, and a simple feed of "new memories reconstructed since you last looked". Browsing lives on the web (and a mobile web view of the same app). This keeps the native surface small enough for one developer.

### 2.4 Communicating uncertainty

Three membership tiers per asset in an event, driven by the confidence score in §9.6:

| Tier | Confidence | UI |
|---|---|---|
| Confirmed | user action, or ≥ 0.85 | no chip |
| Probable | 0.6–0.85 | subtle "probably" chip on hover/long-press |
| Uncertain | < 0.6 | shown in a collapsed "Also possibly from this night (7)" strip at the bottom |

Event-level confidence is expressed in copy, not numbers: "We're fairly sure this was one event" vs "This might be two events — split here?" with the suggested split point highlighted.

## 3. System architecture

### 3.1 Components

```
┌───────────────┐   API (HTTPS)   ┌──────────────────────────────────────────────────┐
│  Expo app     │────────────────▶│  Linux server (Docker Compose, Tailscale)        │
│  iOS/Android  │                 │                                                  │
│  - index      │                 │  api (Fastify) ──▶ postgres (pgvector, trgm,     │
│  - previews   │                 │     │  signs URLs        earthdist, RLS)         │
│  - uploads ───┼──presigned PUT──┼─────┼──────────────┐       ▲ jobs table          │
└───────────────┘                 │     │              │  media-worker (Node: sharp,  │
                                  │     │              │   ffmpeg/NVENC, phash, exif) │
┌───────────────┐   API (HTTPS)   │     │              │       │ pull/push            │
│  Next.js web  │────────────────▶│     │              │  ml-worker (Python: SCRFD,   │
│  browsing UI  │                 │     │              │   ArcFace, OpenCLIP, WBS)    │
│  <img> ───────┼──presigned GET──┼─────┼───────┐      │       │ [GPU]                │
└───────────────┘                 │  caddy    │      │       │  backups (pg_dump +  │
                                  │           │      │       │   restic)            │
                                  └───────────┼──────┼───────┼──────────────────────┘
                                              ▼      ▼       ▼
                                  ┌──────────────────────────────────────────┐
                                  │  Cloudflare R2  bucket `minnegela-media` │
                                  │  (S3 API, jurisdiction EU, zero egress)  │
                                  └──────────────────────────────────────────┘
```

Five containers on the server: `postgres`, `api`, `web`, `media-worker`, `ml-worker`, plus `caddy`. Object storage is Cloudflare R2 in production and a `minio` container in local development; both speak S3 and the code does not know the difference beyond an endpoint URL. Media bytes never transit the home uplink on the way to a browser: phones upload straight to R2 and browsers read straight from R2.

### 3.2 Data flow

1. Phone enumerates new assets, computes metadata + content hash, calls `POST /sync/manifest`.
2. Server answers per asset: `skip` (already have this content), `want_preview`, `want_original`.
3. Phone uploads via presigned PUT directly to R2, then `POST /assets/:id/complete`.
4. API inserts the `job` rows: `derive` (Node) → `analyze` (Python) → `identify` (Python) → debounced `recluster(group, time_window)` (Python). Workers pull the object from R2, do their work, and push derivatives back to R2.
5. Web app reads events, media, people through the API, which applies the presence-gated visibility predicate (§18.3) to every query; media bytes are served by presigned, short-lived R2 GET URLs signed only for objects the caller may see.

### 3.3 Why a separate API from Next.js

Mobile, web, and two workers all need the same domain logic. A Fastify service is a clearer home for it than Next.js route handlers, and it keeps the option of moving workers to other machines (phase 4) without touching the web app.

### 3.4 Why Python for ML and Node for media

InsightFace, OpenCLIP, onnxruntime and PyTorch are Python-first; fighting that costs more than one small Python service. Thumbnails, EXIF, perceptual hashes and ffmpeg orchestration are excellent in Node (`sharp`, `exifr`, `fluent-ffmpeg`) and keep the type-shared domain code in TypeScript. The boundary is the jobs table: no direct calls between the two.

## 4. Client/server ML strategy

### 4.1 Comparison

| Criterion | A. Full server | B. Full client | C. Hybrid (recommended) |
|---|---|---|---|
| Accuracy | Best: full-size models, batch processing, one consistent model version for all users | Worst: mobile-sized models, per-device variance, no cross-user context on device | Same as A for neural models |
| Battery | Uploads only | Heavy: face + CLIP on 20k photos ≈ hours of NPU time; iOS will throttle | Preview generation only (cheap, ~30 ms/photo) |
| Bandwidth | Full originals before any feature works: 60 GB/user upfront | Minimal (only results) | ~250 KB preview per photo up front; originals deferred to Wi-Fi + charging |
| Privacy | Server sees everything | Best on paper; but cross-user matching still needs embeddings on the server, so faces leave the device anyway | Server sees previews and, later, originals. Equivalent to A in practice; mitigated by self-hosting and encryption (§18) |
| Implementation complexity | Lowest: one ML stack | Highest: Core ML + TFLite/NNAPI, model conversion, two runtimes, versioning across devices | Moderate: one ML stack plus a careful upload scheduler |
| iOS restrictions | Background upload via `URLSession` background config works well | Background compute is limited to short `BGProcessingTask` windows; Apple's own Photos ML needs overnight charging for days | Same as A |
| Android restrictions | WorkManager uploads fine | Doze/App Standby buckets throttle; heavy compute needs foreground service with notification | Same as A |
| GPU | GTX 1080 does all the work | Unused | Used |
| Scalability (SaaS) | GPU workers scale horizontally | Scales for free, but the cross-user server side still exists | Same as A; preview-first upload also lowers SaaS storage/egress cost |

### 4.2 Recommendation

**Hybrid, server-heavy.** The decisive arguments:

- Cross-user event reconstruction and identity matching are inherently server-side. Client-side ML cannot remove the server's need to hold face embeddings, so it buys little privacy while costing enormous complexity.
- The GTX 1080 exists and is idle. A phone's NPU is not.
- Preview-first upload gets the magic (faces, events, search) within minutes of install, without waiting for 60 GB of originals.

### 4.3 What the phone actually does

| Responsibility | Mechanism |
|---|---|
| Enumerate library incrementally | `expo-media-library` paginated by `createdAfter`/`modifiedAfter`; periodic full ID reconciliation to detect deletions |
| Metadata | creation time (absolute, from PhotoKit/MediaStore, not EXIF), GPS, dimensions, duration, media type, album membership, `isFavorite`, camera model where available |
| Content identity | MD5 via `getInfoAsync({ md5: true })` for cheap "seen before?"; server recomputes SHA-256 as canonical |
| Preview | JPEG, long edge 1600 px, quality 82, via `expo-image-manipulator` (~200–350 KB). This is what ML runs on |
| Video previews | poster frame + up to 8 frames sampled evenly via `expo-video-thumbnails`; original video deferred |
| Upload | presigned PUT, `expo-file-system` `uploadAsync` with `sessionType: BACKGROUND` on iOS |
| Policy | previews on any network by default (user-configurable), originals only on Wi-Fi + charging, videos only Wi-Fi + charging + under a size cap |

Later (phase 3+), a small Expo native module can add on-device face detection (Vision / ML Kit) so the phone can pre-filter and, if the user wants, only upload media containing group members. Design the manifest protocol so the client can attach optional `hints` today without breaking anything.

### 4.4 What the server does

Everything neural: face detection, face embedding, identity matching, unknown-face clustering, image embeddings, zero-shot tags, quality scoring, near-duplicate grouping, event clustering, title generation, search indexing.

## 5. Face recognition architecture

### 5.1 Models

**Detector: SCRFD-10G** (InsightFace). Fast, accurate on small and profile faces, outputs 5 landmarks for alignment. ~15–25 ms per 640×640 image on a GTX 1080 in fp32.

**Embedder: ArcFace ResNet-50 (glint360k / `buffalo_l` w600k_r50)**, 512-d, L2-normalized. ~3 ms per aligned 112×112 crop, batched. Cosine similarity between same-identity pairs is typically > 0.5, different-identity < 0.3, with the ambiguous band 0.35–0.5.

Both ship as ONNX in the `insightface` package and run on `onnxruntime-gpu`. No training, no fine-tuning.

Alternatives considered: `facenet-pytorch` (MTCNN + InceptionResnet, older and weaker), AdaFace (slightly better on low quality, less packaged), `dlib` (CPU-only, weak). InsightFace wins on quality-per-effort.

### 5.2 Per-face pipeline

For each preview image:

1. Detect faces → boxes, landmarks, detection score.
2. **Quality gating** per face:
   - size: reject if face box < 32 px on the preview (record as `too_small`, still counts as "a face present")
   - blur: variance of Laplacian on the crop; low → `low_quality`
   - pose: yaw estimated from landmark geometry; |yaw| > 60° → `profile`
   - occlusion proxy: detection score < 0.6 → `low_confidence`
3. Align on 5 landmarks, embed.
4. Store `face` row: blob_id, box, landmarks, det score, quality flags, embedding (pgvector, 512-d), and `face_crop` thumbnail (160 px) for UI.

Quality flags do not delete faces; they lower the maximum identity confidence a face can receive (§5.4). A profile shot of Emma in sunglasses should still be *suggested* as Emma with a "maybe" chip, not silently dropped.

### 5.3 Identity model

- A **person** is a group-scoped entity. A person can be linked to a member user ("this is me") or be a labelled non-member ("Sara").
- Each person has **prototypes**: 1–12 embeddings that summarize their confirmed faces. Computed by running k-means (k = min(12, ⌈n/8⌉)) on all confirmed face embeddings and taking centroids, re-normalized. Multiple prototypes capture glasses/no glasses, beard, hair, age drift, and indoor/outdoor lighting far better than one mean vector.
- **Enrollment**: a user takes or picks 3–5 reference photos (front, slight left, slight right, one with their usual glasses/hat). These become the first confirmed faces and prototypes. Then the system immediately proposes matches from the library; each confirmation refines prototypes. Enrollment takes under a minute and is the app's onboarding moment.

### 5.4 Matching

For each new face embedding `f`:

```
for each person p in group:
    s_p = max over prototypes q of p:  cos(f, q)
best, second = top two persons by s_p
margin = s_best - s_second
```

Decision:

| Condition | Result |
|---|---|
| `s_best ≥ 0.62` and `margin ≥ 0.10` | assign `high` confidence |
| `s_best ≥ 0.50` and `margin ≥ 0.06` | assign `probable` |
| `s_best ≥ 0.42` | assign `low` (shown only as a suggestion in the people review UI, not used in search by default) |
| else | unassigned |

Quality flags cap the tier: `profile` or `low_quality` faces cap at `probable`; `too_small` cap at `low`. Thresholds are the Phase 0 spike's job to calibrate on your real photos; the numbers above are the expected starting range for ArcFace r50.

**Context boost** (cheap, effective): if the face's asset sits inside an event where person `p` has been confirmed in ≥ 3 other assets, lower the required threshold for `p` by 0.05. This is how the system, not the face model, resolves a blurry side profile at the same party.

### 5.5 Unknown faces

Unassigned faces with quality ≥ `probable`-eligible are clustered nightly per group using agglomerative clustering (average linkage, cosine distance threshold 0.45). Clusters with ≥ 4 faces surface in the People page as "Unnamed person (23 photos)". A user can name them (creates a person), merge them into an existing person, or hide them. HDBSCAN is an option here but agglomerative with a fixed threshold is easier to reason about and there are at most a few thousand unknown faces.

### 5.6 Feedback loop

Every confirm/reject is stored as a `face_label` with the user who made it. Rejections become negative constraints: a face rejected for person `p` is excluded from `p`'s prototypes and any future auto-assignment to `p` is suppressed for that face. Re-running identity for a group is a single idempotent job; it runs after every prototype change (debounced 30 s).

### 5.7 Fast multi-person queries

Source of truth: `asset_people(asset_id, person_id, confidence_tier, source)`. Denormalized for speed: `assets.person_ids int[]` (tiers `high`+`probable`+confirmed) maintained by trigger, with a GIN index. "Mikkel AND Emma" is `person_ids @> ARRAY[1, 2]`, which is a bitmap index scan and returns in milliseconds at any realistic scale. Event-level membership uses the same trick on `events.person_ids`.

## 6. Image understanding architecture

### 6.1 Purpose

Not classification. We need a representation that answers:

- "Do these two photos look like the same place/activity?" (event affinity, near-duplicate grouping)
- "Which photos match the text 'beach' or 'birthday cake'?" (semantic search)
- "Is this a screenshot, meme, document, or receipt?" (exclude from events and from default sharing)

One embedding model serves all three.

### 6.2 Model

**OpenCLIP ViT-B/16 (laion2b_s34b_b88k), 512-d, fp32.** ~100–150 images/s batched on a GTX 1080. Good text-to-image retrieval, well-supported, small enough that the whole pipeline fits in 8 GB of VRAM alongside the face models.

Alternatives: ViT-L/14 (2–3× better retrieval, but ~4× slower and Pascal has no usable fp16, so ~30 img/s; defer to a GPU upgrade), SigLIP (better text retrieval, slightly more setup; evaluate in the spike as a drop-in), DINOv2 (excellent visual similarity but no text tower; would need a second model for search). ViT-B/16 is the pragmatic single choice; keep the embedding column model-versioned so it can be swapped.

### 6.3 Derived signals from the same embedding

Zero-shot tags: cosine similarity against ~40 text prompts ("a photo of food", "a screenshot", "a document", "a meme", "a selfie", "a group of people", "a concert", "a beach", "a city street at night", "a car", "a pet", ...). Store the top 5 with scores in `assets.tags jsonb`. Cheap, useful for filters and event titles, and for exclusion rules (screenshot/document/meme → `is_utility = true`).

Screenshot detection is also done from metadata (PNG, no camera make, dimensions equal to a known screen size). Belt and braces.

### 6.4 Quality and aesthetics

Cheap features for highlight selection and cover choice: sharpness (Laplacian variance), exposure histogram, face count, face sizes, and CLIP similarity to prompts like "a beautiful photo" vs "a blurry accidental photo". Enough for "automatic highlights" in phase 3 without an aesthetic model.

### 6.5 Video

Videos are represented by their sampled frames (≤ 8). Each frame gets faces and a CLIP embedding; the video's embedding is the mean of frame embeddings, and its people are the union. Videos participate in event clustering exactly like photos.

## 7. Event clustering architecture

### 7.1 Definitions

Three levels of grouping. Only the first two exist in v1.

| Level | Scale | Definition | Example |
|---|---|---|---|
| **Moment** | minutes | A run of media from one place and activity; the rows in the timeline UI | "23:14 — Party, 183 photos" |
| **Event** | hours (30 min – ~18 h) | A contiguous interval of group activity at one place or a connected sequence of places; the unit of memory | "Friday night — Grünerløkka" |
| **Trip** (phase 3) | days | A run of consecutive days where the group's media is far from home | "Copenhagen, 12–15 June" |

An event is, by definition, **an interval on the group's timeline**. Two events can overlap in time only if they happen in different places with different people (concurrent activity). That definition is what lets the algorithm stay simple: instead of clustering points in an abstract feature space, we cut a one-dimensional sequence at boundaries and then check each segment for spatial concurrency.

### 7.2 Why the table photo is easy once you think in intervals

Photo B (dinner table, no faces, 23:47) sits between A (23:41, Mikkel + Emma) and D (00:03, Jonas + Mikkel). If nothing suggests a boundary between A and D, B and C are inside the interval and therefore inside the event. B does not need any evidence of its own. Only **boundaries** need evidence. That is the key simplification: the algorithm scores *gaps between consecutive media*, not media themselves.

### 7.3 Signals and how each one is used

| Signal | Used for | Normalization |
|---|---|---|
| Timestamp | ordering; gap size | absolute UTC from OS asset creation date, per-device clock offset applied |
| Timestamp density | adaptive gap tolerance; moment segmentation | local median gap over ±10 neighbours |
| GPS | distance between windows; spatial split | haversine metres; missing GPS = "unknown", never 0 |
| Location similarity | same named place across days ("the cabin") | place cluster id |
| People in nearby photos | window-level people overlap across a candidate boundary | Jaccard over person sets of the 8 assets before and after |
| Number of people | boundary hint (crowd → 2 people at home) | |Δ log(1+n)| between windows |
| Face identities | see people | |
| Visual embeddings | window-level scene similarity across a boundary | mean cosine similarity of CLIP embeddings, windows of 8 |
| Device/user overlap | continuity: the same contributors on both sides suggests no boundary | Jaccard over contributor sets of windows |
| Gaps | primary boundary evidence | Δt in minutes |
| Semantic content | exclude utility media (screenshots, documents); title generation | tags |
| Calendar (future) | boundary prior and title | — |

### 7.4 Signal hygiene before clustering

1. **Exclude utility media** (`is_utility`): screenshots, documents, memes, images with no camera EXIF *and* a re-encoding signature (WhatsApp/Messenger saves). They are never clustering evidence. They can be *attached* to an event afterwards by time with low confidence, hidden by default.
2. **Exclude exact duplicates** (one blob, many assets): the blob participates once; all its assets inherit membership.
3. **Received media**: an asset whose OS creation date is far from its EXIF date (AirDrop keeps EXIF; messenger apps strip it) is flagged `time_uncertain` and gets no vote on boundaries.
4. **Clock offsets**: see §8.2.
5. **Home location** per user: the densest GPS cluster over all their media (DBSCAN, eps 150 m). Used for trip detection and as a weak prior for concurrent-activity splits.

## 8. Cross-user event reconstruction

### 8.1 Pooling is the default

Clustering runs on the group's pooled, clock-corrected timeline. There is no per-user clustering followed by a merge step. Merging separate per-user clusters is where most systems get complicated (partial overlaps, transitive merges, conflicting boundaries). Pooling avoids all of it: Mikkel's 120 photos, Emma's 87, Jonas's 43 and Sander's 65 are just 315 points on one line.

Consequences that fall out for free:

- A user with 3 photos from the event gets them placed correctly because the other 312 establish the interval.
- A user whose photos contain no faces at all still contributes; their photos are placed by time and location.
- Photos uploaded months later slot into existing events (incremental re-clustering, §9.8).

### 8.2 Different phone clocks

Modern phones sync to network time; typical skew is seconds. The real problems are timezone mistakes and received media. Handling:

- Use the OS asset creation timestamp (absolute epoch) as primary. EXIF `DateTimeOriginal` + `OffsetTimeOriginal` as fallback; if no offset, assume the timezone implied by the GPS position, else the user's home timezone.
- Estimate a **per-device offset** from evidence: pairs of near-duplicate blobs (pHash distance ≤ 4) across two devices whose original EXIF timestamps differ. Median difference = offset. Apply only if |offset| > 60 s and supported by ≥ 3 pairs. Cameras imported from a dedicated camera (Sony, Fuji) are a common source of multi-hour offsets; expose a manual "this device's clock was 1 h off between dates X and Y" correction in the admin UI.

### 8.3 GPS accuracy

Photo GPS is typically within 10–50 m outdoors and can be hundreds of metres indoors, or missing entirely (Android needs `ACCESS_MEDIA_LOCATION`; iOS "limited" access strips nothing but the user may deny location on capture). Rules:

- Distances under 300 m are treated as "same place".
- A missing GPS is never a distance of zero and never infinite; it is "unknown", and the affected term is neutral (0.5) in the boundary score.
- Non-GPS media inherit a **provisional location** from the same contributor's nearest-in-time GPS asset if within 45 min; otherwise from the event they land in.

### 8.4 Participants vs contributors

- **Contributor**: a user who has ≥ 1 asset in the event.
- **Participant**: a person (member or not) who was there. A person is a participant if they are recognized in ≥ 1 asset with ≥ `probable` confidence, or if they are a contributor whose assets carry GPS at the event location (you cannot photograph the party from elsewhere). Contributors with only received media (`time_uncertain`) are *not* automatically participants.

### 8.5 Uploaded at different times

Sander installs the app a year later and uploads 65 photos of an event that already exists. The recluster job for the affected window runs, the existing event's interval widens or stays, and Sander's assets attach. The event id is stable across re-clustering (§9.9), so links and manual edits survive.

## 9. Proposed event-clustering algorithm

Name: **Windowed Boundary Segmentation (WBS)**. Two passes over a sorted timeline plus a spatial concurrency check. O(n log n) for the sort, O(n·w) for the scoring with window w = 8. Fully explainable: every boundary has a score and the terms that produced it.

### 9.1 Alternatives considered

| Approach | Verdict |
|---|---|
| DBSCAN on (time, lat, lon) with a scaled metric | Tempting and common, but it cannot use people, contributor or visual evidence without inventing an artificial metric space, and the eps that works for a 6-hour party splits a slow Sunday hike. Chains through continuous days of a trip into one blob. |
| HDBSCAN | Better on varying density, still a point-cloud method with the same signal problem; harder to explain "why did it cut here". |
| Affinity graph + connected components | Naturally multi-signal, but transitive chaining is a real failure mode (one photo bridging two parties merges them) and edits are awkward to express. |
| Hierarchical (agglomerative) over time-adjacent segments | Reasonable; WBS is essentially its greedy, single-level cousin with a better boundary function. Keep as a phase-3 option for the trip level. |
| **WBS (recommended)** | Exploits the one true structural fact: events are time intervals. Multi-signal, incremental, explainable, editable. |

### 9.2 Inputs

For group `g`, a time window `[T0, T1]` (full history on first run; a widened window around new media on incremental runs). Each non-utility asset `a` has: `t` (corrected), `loc` (or null), `people` (set of person ids at ≥ probable), `contrib` (user id), `emb` (512-d), `n_faces`.

Sort by `t`. Let the sequence be `a_1 … a_n`.

### 9.3 Pass 1 — boundary scoring

For each consecutive pair `(a_i, a_{i+1})`, define windows `L = {a_{i-7} … a_i}` and `R = {a_{i+1} … a_{i+8}}` (clipped at the ends), and compute:

**Gap term.** `Δt` in minutes. Adaptive tolerance `τ = clamp(4 · median_gap(L ∪ R), 20, 120)` minutes, i.e. a dense burst tolerates only a short pause, a slow afternoon tolerates a long one.

```
gap = sigmoid((Δt − τ) / (τ / 2))          ∈ (0, 1)
```

Hard rule: if `Δt > 240` min, `gap = 1` regardless.

**Distance term.** Let `d` be the haversine distance between the GPS-centroids of `L` and `R` using only assets with GPS. If fewer than 2 GPS assets on either side, `dist = 0.5` (neutral).

```
dist = 1 − exp(−d / 800 m)                   d = 300 m → 0.31, 2 km → 0.92
```

Adjustment for travel: if `d / Δt` implies a plausible move (< 90 km/h) and `Δt < 30 min`, halve `dist` (driving to the after-party is one night, not two events).

**People term.** `P_L`, `P_R` = union of person sets in each window. If either is empty, `people = 0.5`.

```
people = 1 − jaccard(P_L, P_R)
```

**Visual term.** Mean pairwise cosine similarity between embeddings in `L` and `R` (`s_cross`), compared to the mean within-window similarity (`s_within`). Scenes from one event look more alike than scenes from different events, but only relatively.

```
visual = clamp(0.5 + (s_within − s_cross) · 2, 0, 1)
```

**Contributor term.** `C_L`, `C_R` = contributor sets.

```
contrib = 1 − jaccard(C_L, C_R)
```

**Boundary score.**

```
b_i = 0.45·gap + 0.20·dist + 0.15·people + 0.10·visual + 0.10·contrib
```

Cut where `b_i ≥ 0.5`. Also cut at any user-pinned boundary; never cut inside a user-pinned "keep together" span (§9.9).

Why these weights: time dominates because it is the one signal that is always present and always trustworthy. Distance is second because it is the only signal that can separate concurrent activity. People, visual and contributor are tie-breakers that mostly matter when `Δt` is in the ambiguous 30–120 minute band. The Phase 0 spike will tune them; the shape of the function matters more than the exact numbers.

Worked example (the party): between 23:14 (Mikkel + Emma) and 00:02 (street outside), `Δt = 48`, `τ ≈ 60` (median gap ~15 min) → `gap ≈ 0.35`; the street photo has GPS 40 m from the flat → `dist ≈ 0.05`; people windows both contain Mikkel, Emma, Jonas → `people ≈ 0.2`; visual gets a mild bump (~0.6) because the street looks different; same contributors → `contrib = 0`. `b ≈ 0.16 + 0.01 + 0.03 + 0.06 + 0 = 0.26`. No cut. The street photo stays in the night.

Between 03:02 (outside the house) and the next morning's 10:40 breakfast photo: `Δt = 458 > 240` → `gap = 1` → `b ≥ 0.45 + …` → cut.

### 9.4 Pass 2 — segment post-processing

For each segment from pass 1:

1. **Minimum size.** Segments with < 3 assets and duration < 10 min become `loose` (not an event; shown as "loose photos" on the day). A single stunning sunset photo is still findable by date, place and content, it just isn't an "event".
2. **Concurrent-activity split.** If the segment has ≥ 6 GPS assets, run DBSCAN over GPS positions (eps 500 m, min_samples 3). If it yields ≥ 2 spatial clusters that each span ≥ 30 min and overlap in time, split the segment by spatial cluster. Non-GPS assets go to the cluster of the same contributor's nearest-in-time GPS asset; if none, to the cluster with the highest people-overlap; if still tied, to the largest cluster with `uncertain` confidence. This is the "Jonas at the cabin while the others are in Oslo" case.
3. **Over-long segments.** If duration > 18 h, find the largest internal `b_i` and cut there, repeat. Slow days at a festival would otherwise become a single 3-day event; that is what the Trip level is for.
4. **Adjacent-merge check.** For consecutive segments `S_k, S_{k+1}` with `b` in `[0.5, 0.6)`, compute a segment-level affinity: same place cluster, people Jaccard ≥ 0.5, `Δt < 90` min → merge, but record the seam as a *suggested split point* shown in the UI ("This might be two events").

### 9.5 Moments (timeline rows)

Within each event, moments are a second, stricter WBS run using only `gap` (τ fixed at 20 min), `dist` (eps 150 m) and `visual`, threshold 0.5. Moments get a label from dominant tags ("Dinner", "Outside", "Dancing") when a tag is ≥ 0.6 on ≥ 40 % of the moment's assets, otherwise just the time. Moments are display-only: they are recomputed freely and carry no user edits.

### 9.6 Per-asset membership confidence

```
conf(a) = 0.35·interior + 0.25·geo + 0.20·people + 0.10·visual + 0.10·contributor_support
```

- `interior`: 1 if `a` has ≥ 3 event assets within 30 min on *both* sides; 0.5 if one side; 0 if it is the first or last asset of the event
- `geo`: 1 if GPS within 300 m of the event centroid; 0.5 if no GPS; 0 if > 2 km
- `people`: 1 if any of `a`'s people are event participants; 0.5 if no faces; 0 if only non-participants
- `visual`: cosine similarity of `emb` to the event's mean embedding, rescaled from [0.5, 0.9] to [0, 1]
- `contributor_support`: 1 if `a`'s contributor has ≥ 5 assets in the event; 0.5 if 2–4; 0 if it is their only one

Tier mapping as in §2.4. The ceiling photo at 00:37 scores interior 1, geo 0.5, people 0.5, visual ~0.3, support 1 → ~0.72 → "probably". Correct: shown in the timeline with a quiet chip.

### 9.7 Event-level confidence

`event.confidence = mean(conf)` weighted toward boundary assets, minus 0.1 for each unresolved suggested split point. Used only for copy ("fairly sure" ≥ 0.75, "might be two events" otherwise).

### 9.8 Incremental re-clustering

Trigger: a debounced job per group (60 s after the last new analyzed asset). Scope: `[min(t_new) − 6 h, max(t_new) + 6 h]`, widened to whole existing events that intersect it. Everything outside the window is untouched. Full re-runs happen only on algorithm version changes and are cheap anyway: 100k assets take seconds in numpy.

### 9.9 Stable ids, edits and constraints

Re-clustering must not churn event ids or lose user work.

- **Matching:** after a run, each new segment is matched to existing events in the window by asset overlap (Jaccard). ≥ 0.5 → reuse the id, else create a new id. Unmatched old events with no remaining assets are soft-deleted.
- **Constraints**, stored in `event_constraints`, re-applied on every run:
  - `pin_boundary(t)` — always cut at `t` (user split)
  - `keep_together(asset_set)` — never cut inside the span covered by these assets (user merge)
  - `exclude(asset, event)` — asset may not join this event
  - `include(asset, event)` — asset is forced into this event with `confirmed` tier
  - `frozen(event)` — the event's boundaries never move; new assets inside its interval still join, with the same confidence rules
- **Titles**: `title_auto` is regenerated; `title_manual` wins when set.

### 9.10 Automatic titles (deliberately simple)

Rule-based, in this order:

1. Manual title.
2. Calendar match (future).
3. Birthday match: the event overlaps a member's birthday (±1 day) and that member is a participant → "{Name}'s birthday".
4. Trip context (phase 3) → "{City} trip, day 2".
5. Named place → "{Place name}, {weekday} {evening|afternoon|morning}".
6. Dominant tag with high coverage ("beach", "concert", "hike", "dinner") → "{Tag} in {City}".
7. Fallback: "{Weekday} {time-of-day} — {City}".

No generative model in v1. Titles are about recognisability, and "Friday night — Oslo, 14 March" is more recognisable than anything an LLM would invent.

## 10. Data model

### 10.1 Core entities

```
User            a login. Belongs to ≥ 1 Group via GroupMember.
Group           the friend group; the tenant boundary for everything below.
Device          a phone belonging to a User; carries clock-offset data and sync state.
Blob            physical media content, keyed by SHA-256. Group-scoped. Stored once.
Asset           one user's reference to a Blob: "IMG_1234 on Mikkel's iPhone". Ownership,
                visibility, local id, album membership live here. Many Assets → one Blob.
Derivative      thumbnails, previews, video transcodes, poster frames — per Blob.
Face            a detected face on a Blob (or on a video frame of a Blob) + embedding.
Person          a group-scoped identity; optionally linked to a User.
PersonPrototype k-means centroids of a Person's confirmed faces.
FaceLabel       a human decision about a Face (confirm/reject person).
Event           reconstructed interval; stable id; auto + manual title; confidence.
EventAsset      membership with confidence and tier; source (auto|manual).
Moment          timeline rows within an Event (display only).
EventConstraint user edits that must survive re-clustering.
Place           a group-scoped location cluster with an optional name.
Job             work queue row.
AuditLog        who accessed / changed what.
```

### 10.2 Ownership and scope rules

- Blobs and everything derived from them (derivatives, faces, embeddings) are scoped to a **group**, because the same physical photo could theoretically live in two groups with different consent contexts. In v1 each deployment is one group, but the column exists from day one.
- A Blob is deleted when its last Asset in the group is deleted.
- People, Events and Places are group entities. A Person linked to a User is deleted (with all faces, prototypes and labels) when that User leaves the group or withdraws consent (§18).

## 11. Database schema

PostgreSQL 16. Extensions: `vector`, `pg_trgm`, `earthdistance` (+ `cube`), `pgcrypto`. Drizzle for migrations. Abbreviated; timestamps are `timestamptz`, ids are `uuid` unless noted, and every group-scoped table has `group_id` first in composite indexes.

```sql
-- identity & tenancy --------------------------------------------------------
users            (id, email unique, display_name, birthday date null, created_at)
groups           (id, name, created_by, created_at, settings jsonb)
group_members    (group_id, user_id, role text check in ('owner','member'),
                  joined_at, consent_faces_at timestamptz null,        -- biometric consent
                  pk (group_id, user_id))
devices          (id, user_id, platform, name, clock_offset_s int default 0,
                  last_sync_at, push_token null)

-- physical media --------------------------------------------------------------
blobs            (id, group_id, sha256 bytea unique-per-group, size_bytes bigint,
                  mime, width int, height int, duration_ms int null,
                  phash bit(64) null, storage_key text,          -- s3 key of original (null until uploaded)
                  preview_key text,                              -- 1600px preview (always)
                  captured_at timestamptz null, captured_tz text null,
                  lat double null, lon double null, gps_accuracy_m real null,
                  camera_make text, camera_model text, exif jsonb,
                  is_utility bool default false,                 -- screenshot/doc/meme
                  time_uncertain bool default false,
                  clip_emb vector(512) null, clip_model text,
                  tags jsonb,                                    -- [{tag, score}]
                  quality jsonb,                                 -- sharpness, exposure, ...
                  n_faces int default 0,
                  near_dup_group_id uuid null,
                  analyzed_at timestamptz null, created_at)
  index blobs_group_time on blobs (group_id, captured_at)
  index blobs_phash on blobs (group_id, phash)
  index blobs_geo on blobs using gist (ll_to_earth(lat, lon)) where lat is not null
  index blobs_clip on blobs using hnsw (clip_emb vector_cosine_ops)

assets           (id, group_id, blob_id, owner_user_id, device_id,
                  local_id text,                                 -- PHAsset id / MediaStore id
                  filename, album_names text[],
                  local_created_at timestamptz,                  -- OS creation date (primary time source)
                  local_modified_at, is_favorite bool,
                  visibility text default 'group' check in ('group','private','hidden'),
                  excluded_reason text null,                     -- album rule, user hid, utility
                  person_ids int[] default '{}',                 -- denormalized, trigger-maintained
                  deleted_at timestamptz null, created_at)
  unique (device_id, local_id)
  index assets_group_owner on assets (group_id, owner_user_id)
  index assets_people on assets using gin (person_ids)

derivatives      (blob_id, kind text,   -- 'thumb320','preview1600','poster','frame','video720'
                  storage_key, width, height, bytes, frame_index int null, pk (blob_id, kind, frame_index))

-- faces & people --------------------------------------------------------------
faces            (id, group_id, blob_id, frame_index int null,
                  box jsonb, landmarks jsonb, det_score real,
                  quality_flags text[], emb vector(512),
                  crop_key text,
                  person_id int null, match_score real null,
                  tier text null check in ('confirmed','high','probable','low'),
                  match_source text check in ('auto','label','context'))
  index faces_group_person on faces (group_id, person_id)
  index faces_emb on faces using hnsw (emb vector_cosine_ops)

persons          (id serial, group_id, user_id uuid null, name text, hidden bool default false,
                  cover_face_id uuid null, created_at)
  unique (group_id, user_id) where user_id is not null      -- one linked person per member per group
person_prototypes(person_id, idx smallint, emb vector(512), n_faces int, pk (person_id, idx))
face_labels      (face_id, person_id, verdict text check in ('confirm','reject'),
                  by_user_id, created_at, pk (face_id, person_id))
unknown_clusters (id, group_id, face_ids uuid[], centroid vector(512), n int, dismissed bool)

-- events ----------------------------------------------------------------------
events           (id, group_id, kind text default 'event',     -- 'event' | 'trip' | 'loose'
                  title_auto text, title_manual text null,
                  start_at, end_at, tz text,
                  center_lat double null, center_lon double null, place_id uuid null,
                  contributor_ids uuid[], person_ids int[],
                  n_assets int, n_videos int, confidence real,
                  cover_blob_id uuid null,
                  is_public_to_group bool default false,        -- manual override, see §18.3
                  opened_by_user_id uuid null, opened_at timestamptz null,
                  algo_version int, frozen bool default false,
                  deleted_at null, created_at, updated_at)
  index events_group_time on events (group_id, start_at desc)
  index events_people on events using gin (person_ids)
  index events_contributors on events using gin (contributor_ids)
  index events_public on events (group_id, start_at desc) where is_public_to_group
  index events_title_trgm on events using gin ((coalesce(title_manual, title_auto)) gin_trgm_ops)

event_assets     (event_id, asset_id, blob_id, confidence real,
                  tier text check in ('confirmed','probable','uncertain'),
                  source text check in ('auto','manual'),
                  pk (event_id, asset_id))
  index event_assets_blob on event_assets (blob_id)
event_person_tags(event_id, person_id, by_user_id, created_at, pk (event_id, person_id))
                                                              -- manual "X was there" tags; feed person_ids
moments          (id, event_id, start_at, end_at, label text null, n_assets, blob_ids uuid[])
event_constraints(id, group_id, kind text,   -- pin_boundary | keep_together | exclude | include | frozen
                  event_id uuid null, at timestamptz null, asset_ids uuid[] null,
                  by_user_id, created_at)
places           (id, group_id, name text null, lat, lon, radius_m, n_events, home_of_user_id null)

-- ops ---------------------------------------------------------------------------
jobs             (id bigserial, kind text, payload jsonb, priority int default 0,
                  run_after timestamptz default now(), attempts int default 0,
                  locked_by text null, locked_at null, done_at null, error text null)
  index jobs_ready on jobs (kind, priority desc, run_after) where done_at is null and locked_by is null
audit_log        (id bigserial, group_id, user_id null, action text, target_type, target_id,
                  ip inet, ua text, at timestamptz)
```

Notes:

- `blobs.captured_at` is derived: EXIF with offset > OS creation date > upload time, in that order, corrected by `devices.clock_offset_s` at analysis time and stored corrected.
- The `person_ids` array on `assets` and `events` is the search accelerator. The trigger fires on `faces.person_id`/`tier` changes and on `event_assets` changes.
- One HNSW index on `faces.emb` supports "similar faces" and unknown clustering; identity matching itself runs in the worker against a few hundred prototypes in numpy, no DB vector search needed.
- `events.person_ids` is the union of (a) persons with a `confirmed`, `high` or `probable` face on any of the event's blobs and (b) rows in `event_person_tags`. `events.contributor_ids` is the set of `assets.owner_user_id` over `event_assets`. Both are trigger-maintained and are exactly the arrays the visibility predicate (§18.3) reads, so a face confirmation flips visibility in the same transaction.

### 11.1 Row-level security

The presence rule is also expressed as Postgres RLS policies so that no query path, present or future, can leak an event by omission:

```sql
alter table events enable row level security;
alter table events force row level security;      -- applies to the table owner too

create policy events_presence on events for select using (
  group_id = current_setting('app.group_id')::uuid
  and (
    current_setting('app.user_id')::uuid = any (contributor_ids)
    or (current_setting('app.person_id', true) is not null
        and current_setting('app.person_id')::int = any (person_ids))
    or is_public_to_group
  )
);
-- event_assets, moments: visible iff their event is visible (policy uses exists(select 1 from events …))
-- assets/blobs: visible iff owner_user_id = app.user_id or exists a visible event_assets row
-- faces/unknown_clusters: visible iff the underlying blob is visible
```

The API connects with a role that is not the table owner and is not a superuser; the workers connect with a separate role that bypasses RLS. `current_setting` values are set per transaction by the Drizzle wrapper described in §18.3.

## 12. Search architecture

### 12.1 Query model

Every search, whether typed or built from chips, compiles to the same structured query:

```ts
type SearchQuery = {
  people?: { all?: number[]; any?: number[] };   // "Mikkel + Emma" → all
  time?: { from?: Date; to?: Date };
  place?: { placeId?: string; lat?: number; lon?: number; radiusM?: number; city?: string };
  eventId?: string;
  contributors?: string[];
  mediaType?: 'photo' | 'video';
  semantic?: string;                              // remaining free text → CLIP text embedding
  tags?: string[];
  mode: 'events' | 'media';
};
```

### 12.2 Natural language → structured

A deterministic parser, not an LLM, for v1:

1. **People**: match tokens against group person names and aliases ("me" → the caller's linked person; "Emma" → person; "Emma S" disambiguates). Consume matched tokens.
2. **Time**: `chrono-node` for "in July", "last summer", "March 2025", "Friday" (nearest past). Norwegian and English month/weekday names added to the parser.
3. **Place**: match against `places.name` (trigram) and against reverse-geocoded city names cached on `blobs` (Nominatim, offline-friendly, run once per place cluster).
4. **Event**: trigram match of the remaining text against event titles ("Emma's birthday", "Copenhagen trip") with a threshold; a hit sets `eventId` and consumes the tokens.
5. **Remaining text** → `semantic`.

The parsed chips are displayed above the results. Misparses are corrected by tapping a chip. This transparency is worth more than a smarter parser.

An LLM parser (phase 3, optional) can be added behind the same `SearchQuery` interface for messy queries; keep it out of the hot path.

### 12.3 Execution

Every search runs inside the caller's visibility scope: the presence predicate from §18.3 is the first filter on `events`, and media-mode candidates are restricted to assets the caller owns or that belong to a visible event. Person pages, places, the map and the timeline use the same scope. A person's photo count therefore differs per viewer, by design.

Two result modes:

- **Events mode** (default when the query has people or time and no semantic text): filter `events` by `person_ids @> all`, `person_ids && any`, time overlap, place distance, `contributor_ids`. Rank by recency and confidence. Cheap.
- **Media mode**: filter `assets ⋈ blobs` by the same predicates (people via `assets.person_ids` **or** via event membership: "Emma" also returns faceless photos from events where Emma was a participant, marked "from an event with Emma"). If `semantic` is set, embed the text with the CLIP text tower (cached per query string) and order by `clip_emb <=> query_vec` with pgvector HNSW, after applying the structured filters as a pre-filter (pgvector 0.8+ iterative scan handles filtered HNSW well at this size).

"Me and Emma at the beach" → people = {me, Emma} (all), semantic = "beach" → media mode; candidates are assets where both are present or both are participants in the asset's event; ranked by similarity to "a photo of a beach".

### 12.4 Do we need anything beyond Postgres?

| Option | Verdict |
|---|---|
| pgvector | **Yes.** HNSW over 512-d, ≤ 1M rows, single-digit ms. |
| Postgres full-text | Marginal; titles and names are short. **pg_trgm** for fuzzy title/name matching is enough. |
| Elasticsearch/OpenSearch | **No.** Adds a JVM service and a second source of truth to keep in sync, for facets Postgres does trivially at this scale. |
| Dedicated vector DB | **No** until tens of millions of vectors or multi-tenant isolation needs (phase 4, and even then pgvector partitioned by group is likely fine). |

### 12.5 Latency budget

Structured filters: < 20 ms. Semantic ranking over ≤ 100k candidates: < 50 ms. CLIP text encoding: ~10 ms on GPU; the ML worker exposes a tiny internal HTTP endpoint for text embeddings (the one exception to "no ML over HTTP"), and results are cached in Postgres by normalized query string.

## 13. Media pipeline

### 13.1 Ingest protocol

```
phone                                      api                               storage/workers
  │ POST /sync/manifest {assets:[{localId, md5, size, mime, createdAt, gps, w, h, dur}]}
  │──────────────────────────────────────▶│
  │ ◀── [{localId, action: skip|want_preview|want_original, uploadUrl?, assetId}]
  │ PUT preview.jpg → presigned R2 URL     │
  │──────────────────────────────────────────────────────────────────────────▶ R2
  │ POST /assets/:id/complete {kind:'preview', sha256}
  │──────────────────────────────────────▶│ insert jobs: derive → analyze → identify → recluster
```

- `skip` when the group already has a blob with this MD5+size (same photo AirDropped to a friend). The server still creates the *asset* row for this user pointing at the existing blob; nothing is uploaded.
- `want_preview` for new content; `want_original` is requested later by policy (Wi-Fi + charging) and always for media in events the user marks as favourites.
- Uploads are idempotent by `(device_id, local_id, kind)`.
- Presigned PUTs are single-object, 15-minute, content-length-bound, and scoped to a key the API chose (`groups/{g}/prev/{assetId}.jpg` as a staging key; `derive` renames to the content-addressed key once the SHA-256 is verified). A single PUT covers files up to 5 GB on R2, so the 500 MB video cap needs no multipart flow.
- R2 does not call the API back. Completion is always the phone's `complete` call; a nightly job lists the staging prefix and reconciles orphans (uploaded but never completed → re-enqueue or delete after 7 days).

### 13.2 Server-side stages

Every stage begins by fetching its input object from R2 into the worker's scratch directory and ends by uploading derivatives back. For photo stages the input is the 300 KB preview, so the round trip costs ~20–60 ms on a home connection and is dwarfed by decode and inference. Video stages fetch originals (tens of MB); they run at the lowest priority and are bandwidth-bound on the uplink when pushing the 720p transcode back, which is fine.

| Stage | Worker | Work | Cost per photo |
|---|---|---|---|
| `derive` | Node | verify SHA-256, `exifr` metadata, `sharp` → thumb320 (WebP), pHash (DCT 8×8 on 32×32 gray), screenshot heuristics, write `blobs` fields | ~40 ms CPU |
| `derive` (video) | Node | `ffprobe`, poster + 8 frames via ffmpeg, 720p H.264 transcode via NVENC (`h264_nvenc`), `preview1600` from poster | 5–20 s |
| `analyze` | Python | SCRFD → faces → ArcFace; OpenCLIP embedding; zero-shot tags; quality metrics; write faces + blob fields | ~25 ms GPU |
| `identify` | Python | match faces against prototypes; context boost; update tiers; trigger `person_ids` | ~1 ms |
| `dedupe` | Node | pHash neighbours (Hamming ≤ 6 within ±1 h in the group), build near-dup groups | ~5 ms |
| `recluster` | Python | WBS over the affected window (debounced per group) | seconds per run |
| `titles` | Node | rule-based titles, place naming, reverse geocode (cached) | ms |

Batching: the Python worker pulls up to 64 `analyze` jobs at once to keep the GPU fed. Jobs carry `attempts`; after 5 failures they park with `error` and show in the admin page.

### 13.3 Worker storage adapter

Both workers use the same S3 client (`@aws-sdk/client-s3` in Node, `boto3` in Python) against `R2_ENDPOINT`, with a `LocalStorage` fallback used only in tests. Fetches are cached on local disk with an LRU cap (`WORKER_CACHE_GB`, default 50) so that `derive`, `analyze` and `dedupe` for the same blob do not re-download. Batches of `analyze` jobs prefetch their previews concurrently (16 in flight) before the GPU loop starts, so R2 latency never idles the GPU.

### 13.4 Originals

When an original arrives later, `derive` re-runs metadata (originals carry full EXIF; previews carry a copied subset) and replaces `preview1600` only if the phone-made preview was smaller than 1600 px. ML is **not** re-run: previews are sufficient and re-running would churn face ids.

## 14. Deduplication

Three distinct notions, handled differently:

| Kind | Detection | Storage effect | UX |
|---|---|---|---|
| **Exact duplicate** (same bytes across users; AirDrop, iCloud shared album) | SHA-256 (server) / MD5 (phone pre-check) | one blob, N assets | one item with N owner avatars |
| **Re-encoded copy** (WhatsApp/Messenger/Instagram save; HEIC vs JPEG export of the same shot) | pHash Hamming ≤ 4 and same aspect ratio ±1 % and |Δcapture| ≤ 24 h or one side has no EXIF | keep the **highest-quality** blob's bytes; the other blob becomes a `variant_of` pointer and its original bytes are not stored (its owner still has them on the phone) | one item |
| **Near-duplicate / burst** (same photographer, seconds apart) | pHash ≤ 10 or CLIP cos ≥ 0.95, same contributor, |Δt| ≤ 10 s | all stored | stack: "+4 similar" |
| **Different perspectives** (two phones, same moment) | |Δt| ≤ 60 s, distance ≤ 50 m or unknown, CLIP cos ≥ 0.85 | all stored | shown side by side in the event timeline as a "moment from two angles" |

The perceptual hash is a 64-bit DCT pHash. Neighbour lookup at this scale is a linear scan over the group's hashes in the ±1 h time window (a few hundred rows), not a BK-tree. Do not build indexing infrastructure for this.

Videos: exact dedupe by SHA-256 only. Near-dupe by pHash of the poster frame plus duration ±1 s.

## 15. Storage architecture

### 15.0 Decision: Cloudflare R2 for production object storage

From Phase 2 onward, all media objects live in Cloudflare R2. The server's 2 TB disk stops being the media store and becomes the worker cache and the backup target.

**Why.** The home server's uplink (typically 20–100 Mbit/s) is the wrong place to serve a photo grid: one person scrolling a 300-tile event page pulls 6–8 MB of thumbnails, a 720p video pulls 15 MB, and four people browsing at once would saturate the link and make the app feel slow exactly at the moment it should feel magical. R2 charges nothing for egress, so serving from R2 costs a few dollars a month for storage and nothing for reads.

**What it does and does not give us.**

- Presigned GET/PUT URLs from the S3 endpoint (`<account>.r2.cloudflarestorage.com`) avoid the home uplink entirely. That is the win that matters.
- Presigned URLs on the S3 endpoint are **not** cached by Cloudflare's CDN edge. Reads are served from R2's storage region, which is fast enough. If edge caching becomes desirable (phase 3), put a small Cloudflare Worker on a custom domain in front of the bucket that verifies a short-lived HMAC token issued by the API and serves from cache. Not needed for the first friend group.
- To keep browser caching effective despite per-request signatures, sign GET URLs with expiry aligned to 1-hour buckets (`expires = ceil(now / 1h) · 1h + 1h`) so the same object yields the same URL for up to an hour and `<img>` tags hit the browser cache on re-render.
- Set the bucket's jurisdiction to **EU** at creation; it cannot be changed later. Data then stays in EU datacenters, which matters for GDPR and for the SaaS story.

**Alternatives considered.** MinIO on the home box (rejected for production: uplink bottleneck, and the box becomes a single point of failure for both compute and bytes). Backblaze B2 (cheap storage, but egress is free only via Cloudflare's CDN and the S3 presigning story is less clean). AWS S3 (egress fees make photo grids expensive). Hetzner Object Storage (fine, EU, but with metered egress and less mature tooling).

**Cost at the §15.2 budget.** ~650 GB × $0.015/GB-month ≈ $10/month. Class A operations (writes, ~250k in the first backfill) and Class B (reads, a few million per month at most) round to under $2/month. The first 10 GB are free.

### 15.1 Layout in R2

One bucket `minnegela-media` (EU jurisdiction), keys content-addressed:

```
groups/{group_id}/orig/{sha256[0:2]}/{sha256}.{ext}
groups/{group_id}/prev/{sha256}.jpg          1600 px, q82
groups/{group_id}/thumb/{sha256}.webp        320 px
groups/{group_id}/face/{face_id}.jpg         160 px crops
groups/{group_id}/video/{sha256}/720.mp4, poster.jpg, f{0..7}.jpg
```

Content addressing makes dedupe, verification and backup trivial. Group prefix makes deletion of a whole group one prefix removal, and multi-tenant isolation a matter of per-tenant buckets or bucket policy later. Local development uses the identical layout in a `minio` container; the only environment differences are `S3_ENDPOINT`, `S3_BUCKET`, credentials and `S3_FORCE_PATH_STYLE`.

### 15.2 Budget (4 users, full libraries)

| Item | Assumption | Size |
|---|---|---|
| Photo originals | 60k × 3 MB | 180 GB |
| Video originals | 6k × 60 MB, capped at 500 MB/file | 360 GB |
| Previews | 66k × 300 KB | 20 GB |
| Thumbs + face crops | 66k × 25 KB + 150k × 8 KB | 3 GB |
| Video 720p + frames | 6k × 15 MB | 90 GB |
| Postgres (embeddings dominate: 66k × 2 KB + 150k × 2 KB) | | < 2 GB |
| **Total** | | **~650 GB** |

In R2 this is about $10/month. On the server, the same 2 TB now holds: the worker cache (capped at 50 GB), Postgres, and a full `restic` mirror of the bucket (~650 GB), which is the primary backup. The knobs for growth, in order: video original size cap, "originals only for media in events" policy, and a per-user quota shown in the app.

### 15.3 Backups

- Postgres: nightly `pg_dump` to a local directory, kept 14 days.
- R2 bucket: nightly `rclone sync` from R2 to the server's local disk (free egress makes this cheap), then `restic` snapshots of that mirror plus the Postgres dumps to an external disk. R2's own durability covers hardware loss; the local mirror covers accidental or malicious deletion in the bucket, which durability does not. Enable R2 object versioning as a second line once it is generally available in the account.
- The direction is deliberate: the cloud holds the live copy, the home box holds the backup. That is the opposite of v0.1 and it is the better shape.
- Test restore quarterly; write the runbook in `docs/ops/restore.md`.

## 16. Mobile architecture

### 16.1 Stack

Expo SDK (current stable), **dev client** build via EAS (Expo Go cannot do background tasks or media library writes). TypeScript, Expo Router, TanStack Query, `expo-sqlite` for the local index, `expo-secure-store` for tokens.

Modules: `expo-media-library`, `expo-file-system` (background upload sessions), `expo-image-manipulator`, `expo-video-thumbnails`, `expo-background-task` + `expo-task-manager`, `expo-network`, `expo-battery`, `expo-notifications` (optional), `expo-crypto`.

### 16.2 Local index (SQLite)

```
local_assets(local_id pk, md5, size, mime, created_at, modified_at, lat, lon, w, h, dur,
             album_ids, server_asset_id, state: new|manifested|preview_uploaded|original_uploaded|skipped|excluded,
             last_error, updated_at)
sync_state(key, value)   -- last enumerated createdAfter cursor, last full reconciliation, policy
```

### 16.3 Sync loop

```
enumerate()  → page through library by created_at > cursor; upsert local_assets(state=new)
reconcile()  → weekly: list all ids; mark missing as deleted → DELETE /assets/:id (server soft-delete)
manifest()   → batch 200 'new' rows → POST /sync/manifest → update states/ids
preview()    → for 'want_preview': make 1600px JPEG, upload (background session), complete
original()   → for policy-eligible rows: upload original, complete
```

Each function is idempotent and bounded (≤ N items or ≤ T seconds) so it can run inside short background windows.

### 16.4 What the platforms actually allow

**iOS**

- Photo library change notifications only reach a *running* app. Enumeration therefore happens on foreground and inside background task windows.
- `BGAppRefreshTask`: ~30 s, scheduled by the system, unpredictable. Use for `enumerate` + `manifest`.
- `BGProcessingTask`: minutes, only when the device is idle, usually charging, typically overnight. Use for `preview` generation. `expo-background-task` maps to this.
- **Background `URLSession` uploads are the workhorse**: files handed to a background session continue uploading after the app is suspended, across hours, and the app is woken to run completion handlers. `expo-file-system`'s `uploadAsync` with `sessionType: BACKGROUND` uses it. So the pattern is: while the app is running (foreground or BG window), generate previews for the next ~100 assets and hand them all to the background session.
- Limited Library access (iOS 14+): the user may select a subset; the app must handle `limited` gracefully and offer "manage selection".
- The app cannot read Photos while the device is locked and the file is `NSFileProtectionComplete`. Preview generation happens while unlocked, uploads can continue while locked.

**Android**

- `WorkManager` periodic work: minimum 15-minute interval, subject to Doze; constraints (unmetered, charging) are honoured. `expo-background-task` maps here. Each run should stay under 10 minutes.
- Foreground service (`dataSync` type) for long initial uploads with a persistent notification; Android 14 caps `dataSync` at 6 h per 24 h, which is fine for an initial backfill spread over nights. Expo has no first-party foreground-service API; either use the WorkManager path only (uploads proceed in ≤ 10-minute chunks) for v1, or write a ~150-line Expo module later.
- `ACCESS_MEDIA_LOCATION` is required to read GPS from media; Android 14's "Selected photos" partial access must be handled like iOS limited access.
- Content URIs: hash by streaming the file; `getInfoAsync({ md5: true })` works on `file://` copies, so copy-to-cache only for previews and hash originals via a stream in a native module later. v1: MD5 of the *preview* is not identity; use size + created_at + local_id for the pre-check on Android, and let the server's SHA-256 be canonical.

**Honest expectation to set in the UI:** "Your library syncs fastest while the app is open and the phone is on Wi-Fi and charging. We'll keep going in the background when the phone lets us." Show a progress ring and a "Sync now" button. Google Photos behaves the same way; users accept it when it is visible.

### 16.5 Screens

1. **Onboarding**: sign in (magic link) → join group via invite code/link → photo permission → identity enrollment (3–5 selfies) → sync policy (defaults: previews on any network, originals on Wi-Fi + charging, videos ≤ 500 MB).
2. **Home**: sync status card (indexed / uploaded / queued / excluded), "new memories" feed (events reconstructed since last visit) that opens the web app in an in-app browser or a shared RN web screen.
3. **Library rules**: albums to exclude, "exclude screenshots", date range to include ("only since 2022"), per-asset hide from the group.
4. **People & privacy**: my identity (reference photos), consent toggle for face recognition, a plain-language explanation of presence-gated visibility with live counts ("2,140 photos indexed · 312 visible to friends in 9 events · 1,828 private to you"), download/delete my data, leave group.
5. **Group**: members, invite, devices, storage use.

### 16.6 Auth on mobile

Better Auth session token stored in SecureStore; refreshed on app start; presigned upload URLs are short-lived (15 min) and per object, so the phone never holds S3 credentials.

## 17. Web architecture

### 17.1 Stack

Next.js App Router, TypeScript, Tailwind, shadcn/ui as a base for forms/dialogs, TanStack Query for API state, MapLibre GL with a self-hosted vector style (or Protomaps PMTiles for fully offline maps), `react-photo-album`/justified layout for grids, a virtualized timeline (TanStack Virtual). Auth via Better Auth cookies. Server components for initial data, client components for the interactive surfaces.

### 17.2 Routes

```
/                      Home: recent events river, quick people/places, "this week last year"
/search?q=…            Parsed chips + results (events or media mode toggle)
/events/[id]           Event page
/people                People grid (members, named, unnamed clusters with review queue)
/people/[id]           Person page; co-appearance chips ("with Emma 41×")
/places, /places/[id]  Place pages
/map                   Map with event pins clustered by zoom; time scrubber
/timeline              Continuous day-by-day scroll (events + loose photos)
/group                 Members, devices, storage, processing status, privacy, audit
/review                Correction queue: unnamed faces, low-confidence matches, suggested splits/merges
```

### 17.3 Event page anatomy

- Header: title (inline editable), date/time span, place (editable), confidence copy, participants avatars (confirmed + "probably" variants), contributors with counts.
- Left/main: **timeline** of moments; each moment is a row with time, location delta ("→ 0.3 km"), label, and a justified grid of its media; contributor avatar badge on each tile; "probably" chip on tier-2 media; "Also possibly from this night (7)" collapsed at the bottom.
- Right rail (desktop) / tabs (mobile): map with a path through moments, people list with per-person counts, highlights (top-N by quality × people × diversity), stats.
- Actions: rename, edit boundaries (drag start/end on a mini-timeline of the surrounding 24 h), split at a moment seam, merge with adjacent event (drag-and-drop in the timeline or "Merge with →"), remove media, download selection, tag a member who was there but has no recognized face ("Sander was here too"), and **"Show to everyone in the group"**, the `is_public_to_group` toggle, available to contributors only. Boundary edits, splits and merges are contributor actions; participants can rename, tag and correct faces.
- Header copy states who can see the event: "Visible to you, Emma, Jonas and Sander" or "Visible to the whole group (opened by Emma)".

### 17.4 Media viewer

Full-screen viewer with keyboard navigation, showing contributor, capture time, place, people (clickable), tags, "similar photos", "other angles of this moment", and the original-download button when the original exists. Videos play the 720p transcode.

### 17.5 Communicating processing state

Every list can show "N items still being analyzed" as a quiet banner; the group page shows a queue depth chart per job kind. Never show a spinner on data that already exists; show what we have and let it improve.

## 18. Privacy and security architecture

### 18.1 Threat model

Assets we protect: photos and videos, face embeddings, GPS traces, relationships (who is with whom), search history. Adversaries: an outsider on the network; a stolen phone; a former group member; a compromised server disk or backup; a curious member trying to see media they should not; the object-storage provider (Cloudflare) as a party that holds ciphertext at rest and can technically read objects; and, for SaaS later, the operator.

### 18.2 Group authorization

- All data is scoped by `group_id`. Every API handler receives `(user, group)` from middleware that has verified membership; queries always include `group_id`. This is enforced by a Drizzle helper that refuses to build group-scoped queries without it, plus a test that walks every route.
- Roles: `owner` (invite, remove, delete group, change group settings) and `member`. No hierarchy of viewers in v1.
- Invites: single-use codes with a 7-day expiry, created by an owner, revocable.

### 18.3 Presence-gated visibility (the zero-creep rule)

There are no per-member sharing settings. Visibility is derived from presence.

**Core rule.** A member `u` (with linked person `p_u`, if enrolled) can see event `e` if and only if at least one holds:

1. **Contributor**: `u` owns at least one asset in `e`'s WBS cluster (`u = any(e.contributor_ids)`).
2. **Participant**: `p_u` is recognized in `e`'s media at `confirmed`, `high` or `probable` tier, or another participant tagged `p_u` on the event (`p_u = any(e.person_ids)`).
3. **Opened**: a contributor set `e.is_public_to_group = true`.

Everything else follows from the rule:

- **Solo moments are private.** An event with one contributor and no other recognized member is visible to that contributor alone. There is no separate "private" state to configure; it is simply an event nobody else has a key to. A weekend hike alone, a Tuesday at the office, a doctor's visit: all invisible to the group, and the owner can still search them.
- **Utility media is private.** `is_utility = true` blobs (screenshots, documents, receipts, memes) never enter `event_assets`, so they never become visible through an event and are never shown in group views. They remain searchable by their owner.
- **Loose media is private to its contributors.** `kind = 'loose'` groupings obey the same predicate; with one contributor that means one viewer.
- **Media visibility is derived from event visibility.** An asset is visible to `u` if `u` owns it or it belongs to at least one event visible to `u` (any tier, including `uncertain`, since those are shown in the event's collapsed strip). Person pages, places, the map, search and the timeline all compose the same predicate; a person's photo count is per viewer.
- **The passive participant.** A member who attended but took no photos sees nothing at first. The moment a participant confirms their face in the review queue, or tags them on the event, the trigger updates `e.person_ids` and the event is visible to them in the same transaction. They get a push notification: "Emma tagged you in Friday night — Grünerløkka". Their own later uploads from the night make them a contributor too.
- **Manual override.** `is_public_to_group` is set by any contributor, recorded with `opened_by_user_id`/`opened_at` and an audit row, and can be turned off again by any contributor. Typical use: a two-person trip shared with the four who stayed home. Opening an event reveals its media from *all* contributors, so the UI names them in the confirmation ("This will show 214 photos from you and Jonas to everyone").
- **Merges and splits.** Merging two events unions `contributor_ids` and `person_ids`, which can widen visibility; the merge dialog says so. A merge requires both events to be visible to the acting user. Splitting recomputes both halves. `is_public_to_group` is inherited by both halves of a split and by the merged result if either input was open.
- **Removing yourself.** A participant can reject their own face match or remove a tag of themselves; that revokes their own access unless they are also a contributor. Contributors can exclude an asset from an event; the asset falls back to owner-only visibility.

**Backend enforcement.** The rule lives in the database layer, not in view logic:

- Every request establishes a viewer context `{groupId, userId, personId | null}` in membership middleware. Drizzle queries run through `withViewer(ctx, tx => …)`, which opens a transaction, runs `select set_config('app.group_id', …, true), set_config('app.user_id', …, true), set_config('app.person_id', …, true)`, and hands back the transaction. Handlers cannot obtain a group-scoped `db` any other way; a lint rule forbids importing the raw client outside `packages/db`.
- Handlers still write the predicate explicitly, through one shared builder, so that query plans use the GIN indexes and so the intent is visible in code review:

```sql
where e.group_id = $groupId
  and ( $userId = any(e.contributor_ids)
     or ($personId is not null and $personId = any(e.person_ids))
     or e.is_public_to_group = true )
```

  `packages/db` exports `visibleEvents(ctx)` (a subquery/CTE) and `visibleAssets(ctx)`; every list, detail, search, map, timeline, people and place query joins through one of them. Media-URL signing checks `visibleAssets` before signing; batch signing filters silently rather than failing, so a grid never leaks by error message.
- The RLS policies in §11.1 are the backstop: with the API's DB role, a query that forgets the predicate returns nothing rather than everything.
- Tests: a fixture group with four members and six events covering each branch of the rule (contributor only, participant by face, participant by tag, opened, solo, utility) is run against every read route; the suite asserts both what is returned and what is not.

**What the owner still controls.** `assets.visibility` keeps two states: `group` (default: eligible for events) and `hidden` (never indexed for the group; derived data deleted). The former `private` state is gone because presence gating makes it redundant. Excluded albums and date ranges (§16.5) map to `hidden`.

### 18.4 Biometric data and consent

- Face recognition of a member is enabled only after that member gives explicit consent in the app (`consent_faces_at`). Until then, their linked person has no prototypes; their face is treated as unknown and is **not** clustered into an "unnamed person" either (detected faces are stored with no embedding matching, and are excluded from unknown clustering, when the detection sits on an asset owned by a non-consenting member or matches a non-consenting member's prototypes: not possible without prototypes, so the practical rule is: non-consenting members' faces stay in the unknown pool only if the group setting `cluster_unknown_faces` is on, and it defaults to on for private groups, off for SaaS).
- Non-members ("Sara") can be labelled by a member. For a private self-hosted group this is comparable to naming a friend in a photo album, and GDPR's household exemption (Art. 2(2)(c)) plausibly applies. For SaaS it does not; phase 4 must add a per-group policy that limits naming to members and turns unknown clustering off by default. Design the schema so `persons.user_id is null` rows can be bulk-deleted.
- Withdrawing consent deletes prototypes, labels, and `person_id` assignments for that person; face rows for their assets are kept only as anonymous detections (box + quality), embeddings deleted. This takes one job and is reversible only by re-enrolling.
- Face embeddings never leave the server, are never returned by any API, and are stored in a table that only the ML worker's DB role can read.

### 18.5 Encryption

- In transit: TLS everywhere (Caddy or Tailscale). Presigned URLs are HTTPS.
- At rest on the server: full-disk encryption (LUKS) on the volume holding Postgres, the worker cache and the backup mirror.
- At rest in R2: Cloudflare encrypts objects at rest by default; keys are Cloudflare's. Client-side encryption of objects is incompatible with presigned browser GETs and is not offered. The practical consequence is stated in the privacy page: "Your photos are stored encrypted with Cloudflare in the EU; the server that runs the AI and Cloudflare's storage can both technically read them; nobody outside the group can."
- R2 credentials are an API token scoped to the single bucket with object read/write only (no bucket management), stored as a Docker secret, rotated on member departure of anyone who had server access.
- Backups: restic client-side encryption.
- End-to-end encryption is **not** offered: the server must see pixels to do its job. Say so plainly in the privacy page.

### 18.6 Secure media URLs

Media is served only via presigned R2 GET URLs generated after the `visibleAssets` check, or via the API streaming for face crops in the review queue. Expiry is bucketed to the hour (§15.0) so URLs are browser-cacheable but never live longer than two hours. Thumbnails in a list share one signature batch per request. URLs are never stored in the DB and never embedded in pages that could be cached publicly. The web app uses `Cache-Control: private`. Presigned PUTs are bound to a key, a content length and a 15-minute window.

### 18.7 Deletion and leaving

- **Delete an asset** (from the app or the web): soft-delete immediately (disappears from every view), hard-delete after 7 days: derivatives, faces, embeddings, event memberships; the blob if no other asset references it. Re-clustering runs on the affected window.
- **Deleted on the phone**: reconciliation propagates as a delete by default (configurable: "keep a copy in the group after I delete from my phone").
- **Leave a group**: the user chooses "take my media with me" (all their assets and derived data are deleted, events re-clustered; other members' photos of them remain, as in real life) or "leave my contributions". Their person is unlinked; with consent withdrawal their prototypes and labels are deleted. Their sessions and device tokens are revoked.
- **Delete the group**: owner action with a 7-day grace, then prefix deletion in R2 (paged `DeleteObjects`, verified by a listing) and cascade in Postgres; the local backup mirror drops the prefix on its next sync and restic snapshots are pruned after 30 days; audit log kept 30 days then deleted.
- **GDPR subject access / portability**: a "Download my data" job produces a zip of the user's originals + a JSON of their metadata, faces (boxes only), and event memberships.

### 18.8 Access logging

`audit_log` records: login, invite, join, leave, consent changes, event opening/closing (`is_public_to_group`), manual participant tags, asset hides, deletions, downloads of originals, exports, admin actions, and every media-URL signing batch (grouped: one row per request, not per thumbnail). Members can see who downloaded originals of their media. Logs are group-visible to owners.

### 18.9 Server compromise

Assume the box can be lost. Mitigations that actually matter for a hobby box: LUKS at rest, no public ports (Tailscale), automatic OS updates, Docker images pinned and rebuilt monthly, secrets in `.env` with 600 permissions (Docker secrets later), Postgres not exposed outside the compose network, SSH keys only, R2 token scoped to one bucket, and a local mirror of the bucket so a ransomware-style loss of the box or a bad deletion in the bucket are both survivable. Face embeddings are the most sensitive derived data; keep them in a separate schema with a separate DB role, which also makes the SaaS move to a separate store straightforward.

### 18.10 Mobile

Tokens in SecureStore / Keystore. Local SQLite index contains only metadata and hashes, never previews (they are generated into the cache directory and deleted after upload). Biometric app lock is optional and cheap (`expo-local-authentication`).

## 19. GTX 1080 feasibility

| Constraint | Reality | Consequence |
|---|---|---|
| Architecture | Pascal GP104, compute capability 6.1, 8 GB VRAM | Supported by CUDA 12.x drivers. Modern PyTorch wheels for CUDA 12.8+ drop Pascal; **pin a `cu126` (or `cu121`) wheel** and note it in the Dockerfile. onnxruntime-gpu 1.17–1.19 builds work. Test this on day one of the spike. |
| fp16 | Pascal runs fp16 at 1/64 the fp32 rate | **Run everything in fp32.** Do not enable autocast. |
| Tensor cores | None | Throughput ≈ 8.9 TFLOPS fp32; fine for ViT-B and ResNet-50 |
| VRAM | 8 GB | SCRFD (~200 MB) + ArcFace (~170 MB) + ViT-B/16 (~350 MB) + batch activations fit with room; ViT-L/14 fp32 batch 32 also fits but is slow |
| NVENC | Yes (H.264/HEVC, Pascal gen) | Video transcodes at 5–10× realtime; keep ffmpeg with `--enable-nvenc` in the media-worker image |
| Driver | Requires a Pascal-supporting driver (≤ 580 series; NVIDIA has announced Pascal moves to a legacy branch) | Pin the host driver; do not auto-upgrade |

Verdict: the GTX 1080 is entirely adequate for phases 0–3. The pipeline is CPU-bound on decoding and preview generation before it is GPU-bound.

## 20. Performance estimates

Per-photo, server side, fp32, batched:

| Stage | Time | Notes |
|---|---|---|
| Decode 1600 px JPEG + resizes (`sharp`) | 15–30 ms CPU | parallel across cores |
| pHash + EXIF | 5 ms CPU | |
| SCRFD-10G @ 640 | 15–25 ms GPU | |
| ArcFace × avg 1.5 faces | 5 ms GPU | |
| OpenCLIP ViT-B/16 | 7–10 ms GPU (batch 32) | |
| DB writes | 2–5 ms | batched |
| **Total** | **~50–75 ms/photo** | **≈ 15–20 photos/s pipeline throughput** |

- 10,000-photo spike folder: ~10–12 minutes end to end.
- 60,000 photos (4 full libraries): ~1 h of GPU-side work, spread over the days the phones take to upload.
- Videos: 10–20 s each for frames + transcode; 6,000 videos ≈ 24 h of NVENC time, in the background, lowest priority.
- WBS re-clustering: a 100k-asset group runs in < 5 s in numpy; incremental windows in milliseconds.
- Search: < 100 ms end to end including CLIP text encoding.
- Phone: preview generation ~40–80 ms per photo on a recent device; 20k photos ≈ 20 min of foreground time or a couple of overnight charging sessions. Upload of 20k × 300 KB = 6 GB.

## 21. API design

REST, JSON, `/v1`. Auth via Better Auth session cookie (web) or bearer token (mobile). All group-scoped routes are under `/v1/groups/:groupId/…`. Zod schemas in `packages/shared` generate the client and the OpenAPI document.

```
Auth / account
  POST   /v1/auth/*                      (Better Auth handlers)
  GET    /v1/me
  DELETE /v1/me                          account deletion (grace period)
  POST   /v1/me/export                   data export job

Groups
  POST   /v1/groups
  GET    /v1/groups/:g
  PATCH  /v1/groups/:g                   name, settings
  POST   /v1/groups/:g/invites           → {code, expiresAt}
  POST   /v1/invites/:code/accept
  GET    /v1/groups/:g/members
  PATCH  /v1/groups/:g/members/me        consent_faces
  DELETE /v1/groups/:g/members/me        leave {takeMedia: bool}
  GET    /v1/groups/:g/devices
  GET    /v1/groups/:g/status            queue depths, storage, last sync per device

Sync (mobile)
  POST   /v1/groups/:g/devices           register
  POST   /v1/groups/:g/sync/manifest     [{localId, md5?, size, mime, createdAt, modifiedAt, gps?, w, h, dur?, albums}]
                                         → [{localId, assetId, action: skip|want_preview|want_original, upload?: {url, headers}}]
  POST   /v1/groups/:g/sync/uploads      request upload URLs for a batch: [{assetId, kind}] → [{url, headers, expiresAt}]
  POST   /v1/assets/:id/complete         {kind, sha256, bytes}
  DELETE /v1/assets/:id                  (from phone reconciliation or UI)
  PATCH  /v1/assets/:id                  visibility: group | hidden

Browse / search
  GET    /v1/groups/:g/events?from&to&people&place&cursor
  GET    /v1/events/:id                  header + moments + participants + contributors
  GET    /v1/events/:id/media?tier&person&type&cursor
  PATCH  /v1/events/:id                  title, frozen, start/end (creates constraints)
  POST   /v1/events/:id/open             contributor only → is_public_to_group = true (audited)
  POST   /v1/events/:id/close            contributor only → false
  GET    /v1/events/:id/visibility       who can see this event and why (contributor|face|tag|opened)
  POST   /v1/events/:id/tags             {personId}  "X was there"; grants X visibility
  DELETE /v1/events/:id/tags/:personId
  POST   /v1/events/:id/split            {at}
  POST   /v1/events/:id/merge            {withEventId}
  POST   /v1/events/:id/exclude          {assetIds}
  POST   /v1/events/:id/include          {assetIds}
  GET    /v1/groups/:g/search?q&mode&…   → {parsed: chips[], events[] | media[]}
  GET    /v1/groups/:g/timeline?day      day view (events + loose)
  GET    /v1/groups/:g/map?bbox&from&to  event pins / media points
  GET    /v1/media/:blobId               metadata, people, tags, similar, otherAngles
  GET    /v1/media/:blobId/url?kind      → presigned URL (thumb|preview|orig|video720)
  POST   /v1/groups/:g/media/urls        batch signing for grids

People
  GET    /v1/groups/:g/people
  GET    /v1/people/:id                  events, co-appearances, counts
  POST   /v1/groups/:g/people            create (label an unknown cluster)
  PATCH  /v1/people/:id                  name, hidden, merge_into
  POST   /v1/people/:id/enroll           reference photos → faces confirmed
  GET    /v1/groups/:g/review            unnamed clusters, low-confidence faces, suggested splits
  POST   /v1/faces/:id/label             {personId, verdict}

Places
  GET    /v1/groups/:g/places, PATCH /v1/places/:id

Admin
  GET    /v1/groups/:g/jobs, POST /v1/groups/:g/jobs/retry, POST /v1/groups/:g/recluster
  GET    /v1/groups/:g/audit
```

Pagination: opaque cursors everywhere. Errors: RFC 7807 problem+json. Rate limits on auth and signing routes. Every read route under `/v1/groups/:g` and every `/v1/events`, `/v1/media`, `/v1/people`, `/v1/places` route resolves through the viewer context and the `visibleEvents`/`visibleAssets` predicates; an event or asset outside the caller's scope answers 404, never 403, so existence is not disclosed.

## 22. Project structure

```
minnegela/
  apps/
    api/            Fastify, Drizzle, Better Auth, route modules by domain
    web/            Next.js
    mobile/         Expo
    media-worker/   Node: derive, dedupe, titles (shares packages/db with api)
    ml-worker/      Python: analyze, identify, recluster, text-embed endpoint
  packages/
    shared/         Zod schemas, API types, generated client, SearchQuery, constants
    db/             Drizzle schema + migrations (imported by api and media-worker)
    ui/             (later) shared web components
  infra/
    compose.yml     postgres, api, web, media-worker, ml-worker, caddy
    compose.dev.yml adds minio for local development (same S3 layout as R2)
    caddy/          Caddyfile
    scripts/        backup.sh, restore.sh, bootstrap.sh
  docs/
    DESIGN.md       this document
    adr/            one file per decision that changes
    ops/            runbooks
  spike/            Phase 0 notebooks/scripts, throwaway
```

pnpm workspaces + Turborepo. Python worker uses `uv` with a pinned lockfile. GitHub Actions: typecheck, lint, unit tests, Docker image builds; deploy is `ssh server 'cd minnegela && git pull && docker compose up -d --build'` for a long time.

## 23. MVP

The MVP is the end of Phase 1 plus the smallest slice of Phase 2 that proves the thesis:

**Two phones** (you + one friend), one group, previews uploaded, faces recognized for both of you, events reconstructed across both libraries, a web app with Home, Event page with timeline and "probably" chips, Search with people + date + semantic, People page. No map, no places naming, no trips, no highlights, no Android polish beyond "works".

Success criterion, stated up front so it can fail: pick 10 nights/trips you both remember. For at least 8 of them, the system produces one event containing ≥ 90 % of both users' media from it and ≤ 5 % foreign media, and a two-person search finds it within the first three results.

## 24. Development roadmap

### Phase 0 — ML spike (2–3 weeks)

Folder of ~10k of your own photos, Python scripts, no app. Deliverables:

1. Metadata extraction and time normalization report (how many lack GPS, EXIF, offsets).
2. Exact + pHash dedupe stats.
3. SCRFD + ArcFace on all photos; enroll yourself + 3 friends with 5 photos each; measure precision/recall on 300 hand-labelled faces; pick thresholds.
4. OpenCLIP embeddings; zero-shot tags; eyeball a 2-D projection.
5. WBS clustering; produce an HTML dump of events with thumbnails; hand-judge 30 events; tune weights.
6. Throughput numbers on the 1080; confirm the CUDA/torch pin works.
7. Decision memo: go / adjust.

### Phase 1 — Single user (6–8 weeks)

Monorepo, compose stack, API, jobs table, media + ML workers, Expo app with enrollment + sync, web app with Home, Event, Search (people + date), People, media viewer. Object storage is MinIO on the server in this phase, through the same S3 client and key layout that R2 will use. The viewer context, `visibleEvents`/`visibleAssets` and RLS are built now even though a group of one makes them trivial; retrofitting them later is how leaks happen. Only your phone. Ship to your own server and live with it for two weeks.

### Phase 2 — Friend group (6–8 weeks)

Groups, invites, roles, consent, presence-gated visibility end to end (participant by face and by tag, passive-participant notification, `is_public_to_group`, the six-branch visibility test suite), deletion/leave flows, audit log, cross-user dedupe, contributors in the UI, review queue for faces, event edits (rename, split, merge, exclude) with constraints, Android hardening. **Migrate object storage to Cloudflare R2** before inviting anyone: create the EU bucket, `rclone sync` the MinIO bucket into it, flip `S3_ENDPOINT`, set up the nightly R2→local mirror and restic. Invite 3 friends. Hit the MVP criterion.

### Phase 3 — Intelligent memories (8–12 weeks)

Trips, places with naming, map page with time scrubber, moments labels, highlights, semantic search polish (SigLIP evaluation, LLM query parser behind a flag), "this week last year", other-angle linking, unknown-face review improvements, on-device face pre-filter module if privacy demand appears, push notifications for "new memory reconstructed".

### Phase 4 — SaaS (only if 2–3 prove out)

Multi-tenant hardening (RLS is already in place; per-tenant schemas if needed, per-group R2 prefixes → per-tenant buckets, optional Cloudflare Worker for edge caching), GPU workers on cloud (RunPod/Lambda spot) pulling from the same jobs table via a queue façade, Stripe billing by storage, email, status page, SOC-lite policies, the non-member face policy from §18.4, legal review of biometric processing per market, EU hosting. Nothing in phases 0–3 should block this; nothing in phases 0–3 should be built *for* it.

## 25. Technical risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| iOS background sync feels unreliable; users think the app is broken | High | Visible progress, "sync now", background URLSession for uploads, honest copy. Accept that initial backfill takes nights. |
| Pascal dropped by a dependency upgrade | Medium | Pin torch/onnxruntime/driver; test in CI with a `--cuda-smoke` job on the server. Plan a GPU upgrade budget for phase 3. |
| Face thresholds wrong for your friends (siblings, similar looks) | Medium | Multi-prototype identities, margin rule, context boost, review queue. Spike measures it first. |
| WBS merges two simultaneous events without GPS | Medium | People and contributor terms; concurrent split needs GPS; without it, the suggested-split UI is the fallback. |
| Android media location permission denied → no GPS | Medium | Provisional location from same-contributor neighbours; explain the permission clearly. |
| Storage exhaustion from video | Medium | Caps, quotas, "originals only in events" policy, admin dashboard. |
| Received/AirDropped media pollutes timelines | Medium | `time_uncertain` flag, no boundary vote, dedupe by SHA-256. |
| pgvector filtered-search recall degrades with selective filters | Low | pgvector iterative scans; candidate counts are small anyway. |
| Expo module gaps (foreground service, streaming hash) | Medium | Small custom modules are ~150 lines each; budget one week. |
| Postgres-as-queue contention | Low | SKIP LOCKED at this scale is fine to ~100 jobs/s; move to a queue façade in phase 4 if ever. |
| A visibility leak through a query that forgets the predicate | Medium (it is the classic bug) | Single `withViewer` entry point, shared predicate builders, RLS backstop, six-branch fixture run against every read route in CI. |
| Presence gating hides an event from someone who was there but is unrecognized and untagged | High initially, drops with use | The review queue surfaces unknown faces to participants first; the "who can see this" header makes gaps obvious; tagging is one tap. |
| R2 outage or account problem takes media offline while the server is fine | Low | Local mirror can be served by the `minio` container in an emergency by flipping `S3_ENDPOINT`; DNS/URL signing switches with it. |
| Worker round trips to R2 slow the GPU pipeline | Low | Prefetch 16 previews ahead of the GPU loop, local LRU cache; previews are 300 KB. Video stages are uplink-bound by design and lowest priority. |
| Presigned URL churn defeats browser caching | Medium | Hour-bucketed expiries (§15.0). |

## 26. Product risks

| Risk | Mitigation |
|---|---|
| Friends will not install an app that uploads their camera roll | Presence gating is the first sentence of onboarding: "Friends only ever see events you were at together. Everything else stays yours." Show the live private/visible counts (§16.5). |
| Presence gating makes the group feel empty at first (everyone sees only their own solo events) | Onboarding asks each new member to enroll their face immediately and shows "3 events are waiting for someone to confirm your face"; the review queue is the first screen after enrollment. |
| Face recognition feels creepy | Opt-in per member, one-tap withdrawal, embeddings never displayed or exported. Non-member naming is explained. |
| The magic depends on critical mass; two people is boring | Phase 1 makes it valuable for one person (your own reconstructed timeline). Group value is additive, not required. |
| Wrong events feel worse than no events | Confidence tiers, "probably" copy, suggested splits, one-tap corrections that stick. |
| Timeline becomes a firehose of near-identical photos | Burst stacking, other-angle grouping, highlights. |
| Someone uploads media others do not want shared | Asset-level exclude by *anyone pictured* (request removal → owner notified → hidden pending) in phase 2; group owner override. |
| Video makes everything slow and expensive | Lowest-priority jobs, 720p, caps; the product is fine with photos only for a while. |

## 27. What NOT to build

- **No custom-trained models.** Not for faces, not for events. Pretrained embeddings + rules + human feedback.
- **No Elasticsearch, Redis, Kafka, Kubernetes, microservices.** Postgres, R2, two workers, compose.
- **No per-member sharing settings, audiences, or ACL editors.** Presence is the permission model. One toggle per event.
- **No Cloudflare Worker / CDN layer in front of R2** until measured latency on grids says otherwise.
- **No end-to-end encryption.** Incompatible with server-side ML. Be honest instead.
- **No LLM in the search or title path for v1.** Rule-based parsing and titles are more predictable and debuggable.
- **No on-device ML in phase 1–2.** The phone generates previews and uploads.
- **No public sharing links, comments, likes, stories, chat.** It is a memory search engine, not a social network.
- **No original-video streaming or in-browser editing.**
- **No multi-group UI complexity** beyond the schema column until phase 4.
- **No pixel-perfect mobile browsing app.** The web app is the browsing surface.
- **No graph database** for relationships; `person_ids` arrays and a co-occurrence query cover "who is with whom".

## 28. First 20 engineering tasks

Ordered; each is roughly 0.5–3 days.

1. Create the monorepo skeleton (pnpm, Turborepo, `apps/`, `packages/`), CI with typecheck/lint, `infra/compose.yml` with Postgres (pgvector image), `compose.dev.yml` with MinIO, `.env.example` with `S3_ENDPOINT`/`S3_BUCKET`/`S3_JURISDICTION` documented for both MinIO and R2.
2. Spike script `spike/00_metadata.py`: walk a 10k-photo folder, extract EXIF/OS time/GPS with `exifread`/`pillow`, write a Parquet; report missing-signal rates.
3. Spike script `spike/01_dedupe.py`: SHA-256 + pHash; print exact/near-duplicate stats and a contact sheet of near-dupes.
4. Spike: verify GTX 1080 stack: pinned `torch` cu126 wheel + `onnxruntime-gpu` in Docker with `--gpus all`; run `nvidia-smi` smoke and a 1,000-image benchmark.
5. Spike script `spike/02_faces.py`: SCRFD + ArcFace over the folder; store embeddings + crops; simple enrollment from 5 photos per person; matching with margin rule; produce a review HTML.
6. Hand-label 300 faces; compute precision/recall per threshold; fix thresholds and quality caps; write `docs/adr/0001-face-thresholds.md`.
7. Spike script `spike/03_clip.py`: OpenCLIP ViT-B/16 embeddings + zero-shot tags; screenshot/document exclusion; text-query sanity check ("beach", "birthday cake").
8. Spike script `spike/04_wbs.py`: implement WBS end to end (boundary scoring, post-processing, moments, confidence); HTML dump of events with thumbnails and boundary explanations.
9. Judge 30 events, tune weights, write `docs/adr/0002-event-clustering.md` with the final formulas. Phase 0 exit review.
10. `packages/db`: Drizzle schema from §11 including `is_public_to_group` and `event_person_tags`, the `person_ids`/`contributor_ids` triggers, RLS policies from §11.1 with separate `api` and `worker` roles, `withViewer` and the `visibleEvents`/`visibleAssets` builders, migrations, seed script with the six-branch visibility fixture; `packages/shared`: Zod schemas for the manifest and search query.
11. `apps/api`: Fastify bootstrap, Better Auth (magic link), group creation/invite/accept, membership middleware, health route, audit log helper.
12. `apps/api`: `StorageProvider` on `@aws-sdk/client-s3` (endpoint-agnostic, hour-bucketed GET expiries, key/length-bound PUTs); sync routes (`manifest`, `uploads`, `complete`, asset delete); jobs table + `enqueue` helper; integration tests against the MinIO container, plus one smoke test against a real R2 bucket run manually.
13. `apps/media-worker`: job consumer (SKIP LOCKED), `derive` for photos (sharp, exifr, pHash, thumbs), `dedupe`; run against seeded uploads.
14. `apps/ml-worker`: job consumer in Python, `analyze` (faces + CLIP + tags), `identify`, prototype computation, `person_ids` trigger; port the spike code, no notebooks.
15. `apps/ml-worker`: `recluster` job with WBS, event id stability, constraints application, moments, titles v1 (rules).
16. `apps/mobile`: Expo dev client, auth, join group, media permission handling (full/limited), SQLite index, `enumerate` + `manifest` + preview generation + background upload; sync status screen.
17. `apps/mobile`: identity enrollment flow (3–5 reference photos → `/people/:id/enroll`), library rules (exclude albums/screenshots/date range), privacy screen (consent toggle, share scope).
18. `apps/web`: Next.js bootstrap, auth, Home (events river), Event page with moments timeline, tiers, "who can see this" header, open/close toggle, participant tagging, media viewer with batch-signed URLs.
19. `apps/web`: Search (parser with people/time/event title + CLIP semantic), People page, review queue for unnamed faces and low-confidence matches.
20. Ops: Caddy/Tailscale, LUKS check, R2 bucket (EU jurisdiction, scoped token), `migrate-to-r2.sh` (`rclone sync` + endpoint flip), `backup.sh` (nightly R2→local mirror, pg_dump, restic), `restore.md` runbook, admin status page (queues, storage, per-device sync, R2 usage). Deploy, install on your phone, live with it for two weeks before inviting anyone.
