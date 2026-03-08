#!/usr/bin/env bash
set -euo pipefail

# Restore missing Hunter media files from OLD host (read-only) into NEW host.
# Safety guarantees:
# - No DB writes
# - No deletes
# - No overwrite of existing files in NEW

NEW_HOST="${HUNTER_NEW_HOST:-ubuntu@16.59.92.121}"
OLD_HOST="${HUNTER_OLD_HOST:-ubuntu@3.148.219.40}"
SSH_KEY="${HUNTER_SSH_KEY:-$HOME/dev/LightsailDefaultKey-us-east-2.pem}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)

NEW_DB_PATH="${HUNTER_NEW_DB_PATH:-/opt/hunter/state/dev.db}"
NEW_UPLOADS_DIR="${HUNTER_NEW_UPLOADS_DIR:-/opt/hunter/state/uploads}"
NEW_ASSETS_DIR="${HUNTER_NEW_ASSETS_DIR:-/opt/hunter/state/assets}"

OLD_UPLOADS_DIR="${HUNTER_OLD_UPLOADS_DIR:-/opt/hunter/backend/uploads}"
OLD_ASSETS_DIR="${HUNTER_OLD_ASSETS_DIR:-/opt/hunter/backend/assets}"
OLD_STATE_UPLOADS_DIR="${HUNTER_OLD_STATE_UPLOADS_DIR:-/opt/hunter/state/uploads}"
OLD_STATE_ASSETS_DIR="${HUNTER_OLD_STATE_ASSETS_DIR:-/opt/hunter/state/assets}"
OLD_VAR_ASSETS_DIR="${HUNTER_OLD_VAR_ASSETS_DIR:-/var/lib/hunter/assets}"

MODE="DRY_RUN"
if [[ "${1:-}" == "--execute" ]]; then
  MODE="EXECUTE"
fi

timestamp="$(date +%Y-%m-%d_%H-%M-%S)"
report_file="${HUNTER_RESTORE_REPORT:-/tmp/hunter_restore_missing_media_${timestamp}.report.txt}"
tmp_dir="$(mktemp -d /tmp/hunter-restore-media-XXXXXX)"
trap 'rm -rf "$tmp_dir"' EXIT

entries_file="$tmp_dir/entries.tsv"
new_files_file="$tmp_dir/new_files.txt"
old_files_file="$tmp_dir/old_files.txt"
plan_file="$tmp_dir/plan.tsv"

log() {
  printf '[restore_media] %s\n' "$*" | tee -a "$report_file"
}

ssh_new() {
  ssh -n "${SSH_OPTS[@]}" "$NEW_HOST" "$@"
}

ssh_old() {
  ssh -n "${SSH_OPTS[@]}" "$OLD_HOST" "$@"
}

{
  echo "timestamp=$timestamp"
  echo "mode=$MODE"
  echo "new_host=$NEW_HOST"
  echo "old_host=$OLD_HOST"
  echo "new_db_path=$NEW_DB_PATH"
  echo "new_uploads_dir=$NEW_UPLOADS_DIR"
  echo "new_assets_dir=$NEW_ASSETS_DIR"
  echo "old_uploads_dir=$OLD_UPLOADS_DIR"
  echo "old_assets_dir=$OLD_ASSETS_DIR"
  echo
} > "$report_file"

log "Precheck conexión NEW/OLD"
ssh_new "hostname >/dev/null"
ssh_old "hostname >/dev/null"
ssh_new "test -f $(printf '%q' "$NEW_DB_PATH")"

log "Extrayendo referencias desde DB (Message.mediaPath + WorkspaceAsset.storagePath)"
ssh_new "sqlite3 -readonly -cmd '.timeout 5000' $(printf '%q' "$NEW_DB_PATH") \
\"select 'MESSAGE' as kind, id, mediaPath from Message where mediaPath is not null and trim(mediaPath) <> '' \
 union all \
 select 'ASSET' as kind, id, storagePath from WorkspaceAsset where storagePath is not null and trim(storagePath) <> '';\"" \
  > "$entries_file"
log "Referencias detectadas en DB: $(wc -l < "$entries_file" | tr -d ' ')"

log "Indexando archivos presentes en NEW"
{
  ssh_new "if [ -d $(printf '%q' "$NEW_UPLOADS_DIR") ]; then find $(printf '%q' "$NEW_UPLOADS_DIR") -type f -print; fi"
  ssh_new "if [ -d $(printf '%q' "$NEW_ASSETS_DIR") ]; then find $(printf '%q' "$NEW_ASSETS_DIR") -type f -print; fi"
} | sed '/^$/d' | sort -u > "$new_files_file"
log "Archivos indexados en NEW: $(wc -l < "$new_files_file" | tr -d ' ')"

log "Indexando archivos disponibles en OLD (solo lectura)"
ssh_old "for d in \
$(printf '%q' "$OLD_UPLOADS_DIR") \
$(printf '%q' "$OLD_ASSETS_DIR") \
$(printf '%q' "$OLD_STATE_UPLOADS_DIR") \
$(printf '%q' "$OLD_STATE_ASSETS_DIR") \
$(printf '%q' "$OLD_VAR_ASSETS_DIR"); do \
  if [ -d \"\$d\" ]; then find \"\$d\" -type f -print; fi; \
done" | sed '/^$/d' | sort -u > "$old_files_file"
log "Archivos indexados en OLD: $(wc -l < "$old_files_file" | tr -d ' ')"

python3 - "$entries_file" "$new_files_file" "$old_files_file" "$plan_file" "$NEW_UPLOADS_DIR" "$NEW_ASSETS_DIR" "$OLD_UPLOADS_DIR" "$OLD_ASSETS_DIR" "$OLD_STATE_UPLOADS_DIR" "$OLD_STATE_ASSETS_DIR" "$OLD_VAR_ASSETS_DIR" <<'PY'
import pathlib
import sys

entries_path = pathlib.Path(sys.argv[1])
new_files_path = pathlib.Path(sys.argv[2])
old_files_path = pathlib.Path(sys.argv[3])
plan_path = pathlib.Path(sys.argv[4])
NEW_UPLOADS_DIR = sys.argv[5].rstrip("/")
NEW_ASSETS_DIR = sys.argv[6].rstrip("/")
OLD_UPLOADS_DIR = sys.argv[7].rstrip("/")
OLD_ASSETS_DIR = sys.argv[8].rstrip("/")
OLD_STATE_UPLOADS_DIR = sys.argv[9].rstrip("/")
OLD_STATE_ASSETS_DIR = sys.argv[10].rstrip("/")
OLD_VAR_ASSETS_DIR = sys.argv[11].rstrip("/")

new_files = set(x.strip() for x in new_files_path.read_text(encoding="utf-8", errors="ignore").splitlines() if x.strip())
old_files = set(x.strip() for x in old_files_path.read_text(encoding="utf-8", errors="ignore").splitlines() if x.strip())

def norm_rel(raw: str, bucket: str) -> str:
    val = (raw or "").strip()
    if val.startswith("/"):
        marker = f"/{bucket}/"
        idx = val.find(marker)
        if idx >= 0:
            val = val[idx + len(marker):]
    if val.startswith(f"{bucket}/"):
        val = val[len(bucket) + 1:]
    return val.lstrip("/") or pathlib.Path(raw).name

def new_candidates(kind: str, raw: str):
    out = []
    raw = (raw or "").strip()
    if raw.startswith("/"):
        out.append(raw)
    if kind == "MESSAGE":
        rel = norm_rel(raw, "uploads")
        out += [
            f"{NEW_UPLOADS_DIR}/{raw}",
            f"{NEW_UPLOADS_DIR}/{rel}",
            f"/opt/hunter/backend/uploads/{raw}",
            f"/opt/hunter/backend/uploads/{rel}",
            f"/opt/hunter/current/backend/uploads/{raw}",
            f"/opt/hunter/current/backend/uploads/{rel}",
        ]
    else:
        rel = norm_rel(raw, "assets")
        out += [
            f"{NEW_ASSETS_DIR}/{raw}",
            f"{NEW_ASSETS_DIR}/{rel}",
            f"/opt/hunter/backend/assets/{raw}",
            f"/opt/hunter/backend/assets/{rel}",
            f"/var/lib/hunter/assets/{raw}",
            f"/var/lib/hunter/assets/{rel}",
        ]
    return out

def old_candidates(kind: str, raw: str):
    out = []
    raw = (raw or "").strip()
    if raw.startswith("/"):
        out.append(raw)
    if kind == "MESSAGE":
        rel = norm_rel(raw, "uploads")
        out += [
            f"{OLD_UPLOADS_DIR}/{raw}",
            f"{OLD_UPLOADS_DIR}/{rel}",
            f"{OLD_STATE_UPLOADS_DIR}/{raw}",
            f"{OLD_STATE_UPLOADS_DIR}/{rel}",
            f"/opt/hunter/backend/{raw}",
        ]
    else:
        rel = norm_rel(raw, "assets")
        out += [
            f"{OLD_ASSETS_DIR}/{raw}",
            f"{OLD_ASSETS_DIR}/{rel}",
            f"{OLD_STATE_ASSETS_DIR}/{raw}",
            f"{OLD_STATE_ASSETS_DIR}/{rel}",
            f"{OLD_VAR_ASSETS_DIR}/{raw}",
            f"{OLD_VAR_ASSETS_DIR}/{rel}",
        ]
    return out

def dst_path(kind: str, raw: str):
    if kind == "MESSAGE":
        return f"{NEW_UPLOADS_DIR}/{norm_rel(raw, 'uploads')}"
    return f"{NEW_ASSETS_DIR}/{norm_rel(raw, 'assets')}"

rows = []
for line in entries_path.read_text(encoding="utf-8", errors="ignore").splitlines():
    if not line.strip():
        continue
    parts = line.split("|", 2)
    if len(parts) < 3:
        continue
    kind, record_id, raw_path = parts[0].strip(), parts[1].strip(), parts[2].strip()
    if not kind or not raw_path:
        continue

    present = any(c in new_files for c in new_candidates(kind, raw_path))
    if present:
        rows.append(("PRESENT", kind, record_id, raw_path, "", ""))
        continue

    src = ""
    for c in old_candidates(kind, raw_path):
        if c in old_files:
            src = c
            break
    if not src:
        rows.append(("MISSING", kind, record_id, raw_path, "", ""))
        continue

    rows.append(("RESTORE", kind, record_id, raw_path, src, dst_path(kind, raw_path)))

with plan_path.open("w", encoding="utf-8") as f:
    for r in rows:
        f.write("\t".join(r) + "\n")
PY

log "Plan generado: $(wc -l < "$plan_file" | tr -d ' ') filas"

total=0
present=0
restored=0
missing=0
errors=0
restored_message=0
restored_asset=0
missing_message=0
missing_asset=0
used_sources_file="$tmp_dir/used_sources.txt"
touch "$used_sources_file"

while IFS=$'\t' read -r status kind record_id raw_path src_old dst_new; do
  [[ -z "${status:-}" ]] && continue
  total=$((total + 1))

  if [[ "$status" == "PRESENT" ]]; then
    present=$((present + 1))
    continue
  fi

  if [[ "$status" == "MISSING" ]]; then
    missing=$((missing + 1))
    if [[ "$kind" == "MESSAGE" ]]; then
      missing_message=$((missing_message + 1))
    else
      missing_asset=$((missing_asset + 1))
    fi
    printf 'MISSING\t%s\t%s\t%s\n' "$kind" "$record_id" "$raw_path" >> "$report_file"
    continue
  fi

  printf '%s\n' "$src_old" >> "$used_sources_file"
  if [[ "$MODE" == "DRY_RUN" ]]; then
    printf 'DRY_RUN_RESTORE\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$record_id" "$raw_path" "$src_old" "$dst_new" >> "$report_file"
    continue
  fi

  if ssh_new "test -f $(printf '%q' "$dst_new")"; then
    present=$((present + 1))
    continue
  fi

  local_tmp="$tmp_dir/${record_id}_$(basename "$dst_new").bin"
  if ssh_old "cat $(printf '%q' "$src_old")" > "$local_tmp"; then
    if ssh_new "mkdir -p $(printf '%q' "$(dirname "$dst_new")") && cat > $(printf '%q' "$dst_new")" < "$local_tmp"; then
      if ssh_new "test -f $(printf '%q' "$dst_new")"; then
        restored=$((restored + 1))
        if [[ "$kind" == "MESSAGE" ]]; then
          restored_message=$((restored_message + 1))
        else
          restored_asset=$((restored_asset + 1))
        fi
        printf 'RESTORED\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$record_id" "$raw_path" "$src_old" "$dst_new" >> "$report_file"
      else
        errors=$((errors + 1))
        printf 'ERROR_VERIFY\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$record_id" "$raw_path" "$src_old" "$dst_new" >> "$report_file"
      fi
    else
      errors=$((errors + 1))
      printf 'ERROR_UPLOAD\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$record_id" "$raw_path" "$src_old" "$dst_new" >> "$report_file"
    fi
  else
    errors=$((errors + 1))
    printf 'ERROR_READ_OLD\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$record_id" "$raw_path" "$src_old" "$dst_new" >> "$report_file"
  fi
done < "$plan_file"

{
  echo
  echo "SUMMARY"
  echo "total_referenced=$total"
  echo "already_present=$present"
  echo "restored=$restored"
  echo "still_missing=$missing"
  echo "errors=$errors"
  echo "restored_message=$restored_message"
  echo "restored_asset=$restored_asset"
  echo "missing_message=$missing_message"
  echo "missing_asset=$missing_asset"
  echo
  echo "SOURCE_PATHS_USED"
  sort -u "$used_sources_file"
} >> "$report_file"

log "Reporte generado: $report_file"
log "Resumen => total=$total present=$present restored=$restored missing=$missing errors=$errors"

