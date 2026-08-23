# Portable export validation and restore drill

Owner exports contain workspace/member metadata, current Markdown pages,
attachment objects, page ACLs, tags, page-tag relationships, Wiki links,
aliases, and comments. Authentication identities and credentials are excluded.
Every page and asset record includes its byte size and SHA-256 digest. The ZIP itself is hashed
after R2 multipart completion and the digest is exposed as `archiveHash` by the
export status API.

Before a staging restore drill, validate the downloaded archive locally:

```powershell
npm run validate:portable-export -- C:\path\to\wiki-export.zip
```

The validator rejects an invalid manifest graph, unsafe or duplicate manifest
paths, missing or unexpected files, byte-size mismatches, and SHA-256
mismatches. Its JSON output records the source workspace, export timestamp,
logical record counts, and whole-archive SHA-256 for the drill log.

The automated Worker test reconstructs an empty logical workspace from an
archive and checks page, asset, and link integrity. The production API does not
yet mutate a staging workspace from an uploaded portable ZIP; staging restore
therefore remains an operator-controlled migration after validation.

## Scheduled logical backups

`runWeeklyBackupMaintenance(env, now)` in
`apps/worker/src/exports/service.ts` is the scheduled integration point. The
Worker invokes it for `0 18 * * 6` (Sunday 03:00 JST). It starts or resumes one
idempotent `ExportWorkflow` per active workspace and backup date, then removes
expired R2 artifacts.

- The first weekly backup in each Japanese calendar month is the monthly
  representative and is retained for 12 calendar months.
- Other weekly backups are retained for 90 days.
- Interactive download exports are retained for 7 days.
- Expired jobs retain their D1/audit record as `cancelled`, while the archive,
  plan, and any staged segments are deleted from R2.
