# Bound image height cache retention

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 4.

## Plan

Use bounded retention for measured heights and avoid retaining embedded image data in keys.

Keep 256 recent measured image heights with access-based eviction. Use fixed-size fingerprints for data URLs and keys over 512 characters so metadata never owns encoded image bytes. Compute a widget key once; use the same cache access/measurement functions for markdown images and wiki embeds. Height data remains advisory: a rare fingerprint collision is corrected on decode. Verify access recency, bounded key/count retention and height restoration through existing fold tests and actual browser image load. Update editor docs and changelog.

## Report

Implemented a 256-entry access-ordered cache and fixed-size fingerprints for data URLs and destinations over 512 characters. Original image URLs and widget equality remain unchanged. Both markdown and wiki embeds use the shared height wiring; decode corrects stale hints.

Validation: both retention regressions failed before the fix; all five image-fold tests and the full 1,409-test frontend suite pass. vp check reports zero errors and ten existing warnings. Browser checks exercised shared attachment load/rebuild/error and a real EditorView image: a stale 25px hint corrected to 120px, and encoded bytes were absent from cache keys. Editor and QA plan/implementation reviewers approved; QA reran 65 image/wiki tests. Native WebKit whole-window scroll and allocation profiling remain unverified.
