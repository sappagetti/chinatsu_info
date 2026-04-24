#!/usr/bin/env bash
set -euo pipefail

# 初回/更新用: OTOGE DB の music-ex.json を見て必要なジャケットだけ取得する。
# 既定では assets/jacket へ保存。--prune で不要ファイルを削除できる。

DEST_DIR="${DEST_DIR:-assets/jacket}"
MUSIC_EX_URL="${MUSIC_EX_URL:-https://raw.githubusercontent.com/zvuc/otoge-db/master/ongeki/data/music-ex.json}"
JACKET_RAW_BASE="${JACKET_RAW_BASE:-https://raw.githubusercontent.com/zvuc/otoge-db/master/ongeki/jacket}"
PRUNE="0"

usage() {
  cat <<'EOF'
Usage:
  scripts/sync_jackets.sh [--dest <dir>] [--prune]

Options:
  --dest <dir>   저장 디렉터리 (기본: assets/jacket)
  --prune        현재 목록에 없는 로컬 파일 삭제
  -h, --help     도움말

Env override:
  DEST_DIR
  MUSIC_EX_URL
  JACKET_RAW_BASE
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST_DIR="${2:-}"
      shift 2
      ;;
    --prune)
      PRUNE="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${DEST_DIR}" ]]; then
  echo "--dest is empty" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install: sudo pacman -S --needed jq" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required. Install: sudo pacman -S --needed curl" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

JSON_PATH="${TMP_DIR}/music-ex.json"
LIST_PATH="${TMP_DIR}/jacket-files.txt"

echo "[1/4] Downloading music-ex.json ..."
curl -fsSL "${MUSIC_EX_URL}" -o "${JSON_PATH}"

echo "[2/4] Building jacket file list ..."
jq -r '
  .[]
  | .image_url // .jacket_url // .jacket // .image // empty
  | tostring
  | gsub("\\\\"; "/")
  | split("/")
  | last
  | select(test("\\.(png|jpg|jpeg|webp|gif)$"; "i"))
' "${JSON_PATH}" | sort -u > "${LIST_PATH}"

TOTAL="$(wc -l < "${LIST_PATH}" | tr -d '[:space:]')"
echo "      ${TOTAL} files to sync"

echo "[3/4] Downloading jackets ..."
OK=0
FAIL=0
while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  url="${JACKET_RAW_BASE}/${file}"
  out="${DEST_DIR}/${file}"
  if curl -fsSL "${url}" -o "${out}.tmp"; then
    mv "${out}.tmp" "${out}"
    OK=$((OK + 1))
  else
    rm -f "${out}.tmp"
    echo "WARN: failed ${file}" >&2
    FAIL=$((FAIL + 1))
  fi
done < "${LIST_PATH}"

if [[ "${PRUNE}" == "1" ]]; then
  echo "[4/4] Pruning stale local files ..."
  while IFS= read -r local_file; do
    base="$(basename "${local_file}")"
    if ! grep -Fxq "${base}" "${LIST_PATH}"; then
      rm -f "${local_file}"
    fi
  done < <(find "${DEST_DIR}" -maxdepth 1 -type f)
else
  echo "[4/4] Skip prune (use --prune to enable)"
fi

echo "Done. success=${OK} failed=${FAIL} dir=${DEST_DIR}"
