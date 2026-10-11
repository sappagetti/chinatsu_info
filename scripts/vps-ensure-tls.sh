#!/usr/bin/env bash
# Idempotent host TLS helper for chinatsu.sappagetti.com on the VPS.
#
# Fixes the common failure mode where HTTP→HTTPS redirect (or SPA try_files)
# swallows Let's Encrypt HTTP-01 challenges, so certbot.timer "succeeds" with
# no renewal and the cert expires at day 90.
#
# Usage (on the VPS, as a user with passwordless sudo):
#   DOMAIN=chinatsu.sappagetti.com \
#   CERTBOT_EMAIL=you@example.com \
#   bash scripts/vps-ensure-tls.sh
#
# Env:
#   DOMAIN              (default: chinatsu.sappagetti.com)
#   CERTBOT_EMAIL       required for first issuance; optional for renew
#   WEBROOT             (default: /var/www/certbot)
#   FORCE_RENEW         set to 1 to force certbot renewal
#   NGINX_CONF_SRC      path to repo nginx site config
#   SKIP_NGINX_INSTALL  set to 1 to only renew (assume site config already OK)
#   DRY_RUN             set to 1 to print actions without changing the system

set -euo pipefail

DOMAIN="${DOMAIN:-chinatsu.sappagetti.com}"
WEBROOT="${WEBROOT:-/var/www/certbot}"
FORCE_RENEW="${FORCE_RENEW:-0}"
SKIP_NGINX_INSTALL="${SKIP_NGINX_INSTALL:-0}"
DRY_RUN="${DRY_RUN:-0}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NGINX_CONF_SRC="${NGINX_CONF_SRC:-${REPO_ROOT}/deploy/nginx/${DOMAIN}.conf}"

log() { printf '+ %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY_RUN: $*"
    return 0
  fi
  log "$*"
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

sudo_run() {
  if [[ "$(id -u)" -eq 0 ]]; then
    run "$@"
  else
    run sudo "$@"
  fi
}

# /etc/letsencrypt/live is typically mode 0700 — deploy cannot -f it without sudo.
root_test() {
  if [[ "$(id -u)" -eq 0 ]]; then
    test "$@"
  else
    sudo test "$@"
  fi
}

live_cert_path() {
  echo "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
}

live_cert_exists() {
  root_test -f "$(live_cert_path)"
}

detect_nginx_target() {
  if [[ -d /etc/nginx/sites-available ]]; then
    echo "/etc/nginx/sites-available/${DOMAIN}.conf"
    return
  fi
  if [[ -d /etc/nginx/conf.d ]]; then
    echo "/etc/nginx/conf.d/${DOMAIN}.conf"
    return
  fi
  die "neither /etc/nginx/sites-available nor /etc/nginx/conf.d exists"
}

enable_site_if_needed() {
  local target="$1"
  if [[ -d /etc/nginx/sites-enabled ]]; then
    local link="/etc/nginx/sites-enabled/${DOMAIN}.conf"
    if [[ ! -e "${link}" ]]; then
      sudo_run ln -sfn "${target}" "${link}"
    fi
    # Ubuntu default site often catches :80/:443 first and 301s ACME to HTTPS.
    if [[ -e /etc/nginx/sites-enabled/default ]]; then
      log "disabling /etc/nginx/sites-enabled/default to avoid ACME redirect conflicts"
      if [[ "${DRY_RUN}" != "1" ]]; then
        sudo rm -f /etc/nginx/sites-enabled/default
      fi
    fi
  fi
}

retire_conflicting_server_names() {
  # nginx keeps the *first* server_name match and ignores later duplicates
  # ("conflicting server name ... ignored"). An older conf.d/sites-enabled
  # file that 301s ACME would win forever unless we move it aside.
  local keep="$1"
  local keep_real
  keep_real="$(readlink -f "${keep}" 2>/dev/null || echo "${keep}")"
  local f real
  while IFS= read -r -d '' f; do
    real="$(readlink -f "${f}" 2>/dev/null || echo "${f}")"
    [[ "${real}" == "${keep_real}" ]] && continue
    case "${f}" in
      *.bak|*.disabled|*.rpmnew|*.dpkg-*) continue ;;
    esac
    if sudo grep -Eq "server_name[[:space:]]+([^;]*[[:space:]])?${DOMAIN}([[:space:;]]|$)" "${f}" 2>/dev/null; then
      log "retiring conflicting nginx config: ${f} → ${f}.bak"
      if [[ "${DRY_RUN}" != "1" ]]; then
        sudo mv -f "${f}" "${f}.bak"
      fi
    fi
  done < <(sudo find /etc/nginx -type f \( -name '*.conf' -o -name 'default' \) -print0 2>/dev/null)
}

ensure_certbot_packages() {
  if command -v certbot >/dev/null 2>&1; then
    return
  fi
  need_cmd apt-get
  sudo_run apt-get update -y
  sudo_run apt-get install -y certbot
}

ensure_ssl_snippets() {
  if [[ -f /etc/letsencrypt/options-ssl-nginx.conf && -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    sudo_run apt-get update -y
    sudo_run apt-get install -y python3-certbot-nginx
  fi
  if [[ ! -f /etc/letsencrypt/options-ssl-nginx.conf || ! -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    die "missing /etc/letsencrypt/options-ssl-nginx.conf or ssl-dhparams.pem after certbot-nginx install"
  fi
}

write_http_bootstrap_config() {
  # Used only when no live cert exists yet — HTTPS server block would fail nginx -t.
  local target="$1"
  local tmp
  tmp="$(mktemp)"
  cat >"${tmp}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type "text/plain";
        allow all;
        try_files \$uri =404;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY_RUN: would install HTTP bootstrap config to ${target}"
    rm -f "${tmp}"
    return
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    install -m 0644 "${tmp}" "${target}"
  else
    sudo install -m 0644 "${tmp}" "${target}"
  fi
  rm -f "${tmp}"
  enable_site_if_needed "${target}"
  retire_conflicting_server_names "${target}"
  sudo_run nginx -t
  sudo_run systemctl reload nginx
}

install_nginx_site() {
  [[ -f "${NGINX_CONF_SRC}" ]] || die "nginx config not found: ${NGINX_CONF_SRC}"
  local target
  target="$(detect_nginx_target)"

  sudo_run mkdir -p "${WEBROOT}/.well-known/acme-challenge"

  if ! live_cert_exists; then
    log "no live cert yet — installing HTTP-only bootstrap for ACME"
    write_http_bootstrap_config "${target}"
    return
  fi

  log "installing nginx site config → ${target}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY_RUN: would copy ${NGINX_CONF_SRC} to ${target}"
    return
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    install -m 0644 "${NGINX_CONF_SRC}" "${target}"
  else
    sudo install -m 0644 "${NGINX_CONF_SRC}" "${target}"
  fi
  enable_site_if_needed "${target}"
  retire_conflicting_server_names "${target}"
  sudo_run nginx -t
  sudo_run systemctl reload nginx
}

probe_acme_path() {
  local token="chinatsu-acme-smoke-$$"
  local file="${WEBROOT}/.well-known/acme-challenge/${token}"
  # Do not use a fixed /tmp path — a root-owned leftover makes curl fail with
  # "client returned ERROR on write of 3 bytes" even when nginx returned "ok".
  local out
  out="$(mktemp "${TMPDIR:-/tmp}/acme-smoke.XXXXXX")"
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY_RUN: skip ACME path probe"
    rm -f "${out}"
    return
  fi
  echo "ok" | sudo tee "${file}" >/dev/null
  # nginx worker (http/www-data) must be able to read the token file.
  sudo chmod 755 "${WEBROOT}" "${WEBROOT}/.well-known" "${WEBROOT}/.well-known/acme-challenge" 2>/dev/null || true
  sudo chmod 644 "${file}"
  local code
  code="$(curl -sS -o "${out}" -w '%{http_code}' --max-time 5 \
    "http://127.0.0.1/.well-known/acme-challenge/${token}" \
    -H "Host: ${DOMAIN}" || true)"
  sudo rm -f "${file}"
  if [[ "${code}" != "200" ]]; then
    log "ACME probe body: $(head -c 200 "${out}" | tr '\n' ' ')"
    rm -f "${out}"
    die "ACME path probe failed (HTTP ${code}). /.well-known/acme-challenge/ must return 200 on :80 without redirect."
  fi
  if ! grep -qx 'ok' "${out}"; then
    log "ACME probe body: $(head -c 200 "${out}" | tr '\n' ' ')"
    rm -f "${out}"
    die "ACME path probe returned unexpected body (SPA/proxy leak?)"
  fi
  rm -f "${out}"
  log "ACME path probe ok (HTTP 200, webroot body)"
}

cert_days_remaining() {
  local pem
  pem="$(live_cert_path)"
  if ! root_test -f "${pem}"; then
    echo "-1"
    return
  fi
  local end
  end="$(sudo openssl x509 -enddate -noout -in "${pem}" | cut -d= -f2)"
  local end_epoch now_epoch
  end_epoch="$(date -d "${end}" +%s)"
  now_epoch="$(date +%s)"
  echo $(( (end_epoch - now_epoch) / 86400 ))
}

pin_renewal_webroot() {
  # Ensure certbot.timer renewals keep using webroot (not nginx/standalone).
  # After an emergency --standalone renew, renewal.conf often stays on
  # authenticator=standalone, which fails while nginx holds :80.
  local renewal="/etc/letsencrypt/renewal/${DOMAIN}.conf"
  if ! root_test -f "${renewal}" || [[ "${DRY_RUN}" == "1" ]]; then
    return
  fi
  log "pinning renewal config to webroot (${WEBROOT})"
  sudo sed -i \
    -e 's/^authenticator[[:space:]]*=.*/authenticator = webroot/' \
    -e '/^installer[[:space:]]*=/d' \
    "${renewal}"
  if sudo grep -q '^webroot_path' "${renewal}"; then
    sudo sed -i "s|^webroot_path[[:space:]]*=.*|webroot_path = ${WEBROOT},|" "${renewal}"
  else
    sudo sed -i "/^\[renewalparams\]/a webroot_path = ${WEBROOT}," "${renewal}"
  fi
  if sudo grep -q '^\[\[webroot_map\]\]' "${renewal}"; then
    sudo sed -i "s|^${DOMAIN}[[:space:]]*=.*|${DOMAIN} = ${WEBROOT}|" "${renewal}"
  else
    printf '\n[[webroot_map]]\n%s = %s\n' "${DOMAIN}" "${WEBROOT}" | sudo tee -a "${renewal}" >/dev/null
  fi
}

issue_or_renew() {
  need_cmd certbot
  local args=(certonly --webroot -w "${WEBROOT}" -d "${DOMAIN}" --non-interactive --agree-tos)

  if [[ -n "${CERTBOT_EMAIL}" ]]; then
    args+=(--email "${CERTBOT_EMAIL}")
  elif ! live_cert_exists; then
    die "CERTBOT_EMAIL is required for first certificate issuance"
  fi

  local days
  days="$(cert_days_remaining)"
  log "certificate days remaining: ${days}"

  if ! live_cert_exists; then
    log "no existing cert — issuing via webroot"
    sudo_run certbot "${args[@]}"
  elif [[ "${FORCE_RENEW}" == "1" || "${days}" -lt 30 ]]; then
    log "renewing via webroot (force=${FORCE_RENEW}, days=${days})"
    local renew_args=("${args[@]}" --cert-name "${DOMAIN}")
    if [[ "${FORCE_RENEW}" == "1" || "${days}" -lt 0 ]]; then
      renew_args+=(--force-renewal)
    fi
    sudo_run certbot "${renew_args[@]}"
  else
    log "cert still valid for ${days} days — skipping certbot (set FORCE_RENEW=1 to force)"
  fi

  pin_renewal_webroot
}

enable_timer() {
  if systemctl list-unit-files certbot.timer 2>/dev/null | grep -q certbot.timer; then
    sudo_run systemctl enable --now certbot.timer
    log "certbot.timer status: $(systemctl is-active certbot.timer 2>/dev/null || true)"
    systemctl list-timers --all 2>/dev/null | grep certbot || true
  else
    log "certbot.timer not installed — enable certbot-renew.timer (or certbot.timer) on this host"
  fi

  # Deploy-hook so successful renewals reload nginx without waiting for a reboot.
  local hook_dir="/etc/letsencrypt/renewal-hooks/deploy"
  local hook="${hook_dir}/reload-nginx.sh"
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY_RUN: would install ${hook}"
    return
  fi
  sudo mkdir -p "${hook_dir}"
  sudo tee "${hook}" >/dev/null <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
  sudo chmod +x "${hook}"
  log "installed deploy hook ${hook}"
}

reload_full_site_if_needed() {
  # After first issuance, swap HTTP bootstrap for the full TLS site config.
  live_cert_exists || return 0
  [[ "${SKIP_NGINX_INSTALL}" == "1" ]] && return 0
  [[ -f "${NGINX_CONF_SRC}" ]] || return 0

  local target
  target="$(detect_nginx_target)"
  log "ensuring full TLS site config → ${target}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    return
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    install -m 0644 "${NGINX_CONF_SRC}" "${target}"
  else
    sudo install -m 0644 "${NGINX_CONF_SRC}" "${target}"
  fi
  enable_site_if_needed "${target}"
  retire_conflicting_server_names "${target}"
  sudo_run nginx -t
  sudo_run systemctl reload nginx
}

main() {
  need_cmd nginx
  need_cmd curl
  need_cmd openssl

  ensure_certbot_packages
  ensure_ssl_snippets

  if [[ "${SKIP_NGINX_INSTALL}" != "1" ]]; then
    install_nginx_site
  else
    sudo_run mkdir -p "${WEBROOT}/.well-known/acme-challenge"
  fi

  probe_acme_path
  issue_or_renew
  reload_full_site_if_needed
  enable_timer

  local days
  days="$(cert_days_remaining)"
  log "done. days remaining=${days}"
  if [[ "${days}" -lt 0 ]]; then
    die "certificate still expired after renewal attempt"
  fi
}

main "$@"
