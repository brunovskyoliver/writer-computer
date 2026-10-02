# Release failed PDF search acquisitions

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 2.

## Plan

Balance every PDF acquisition with release, including failed loads and cancellation.

Move the failed-load return inside the existing try/finally so search always releases its acquired reference. Correct the acquire ownership comment. Regressions cover repeated invalid/encrypted/missing PDFs and a failed search sharing a reference with an open tab. Formal review is skipped for this obvious one-line ownership correction.

## Report

The failed-load return now runs inside the existing release finally block. The ownership comment explicitly requires releasing failed acquisitions too. Four new regression cases failed before the fix and pass afterward: repeated corrupt, encrypted and missing PDF searches release their entries and idle worker; a failed search releases only its own reference while a tab holds another. PDF cache/search suites pass. Formal review skipped for the one-line ownership correction.
