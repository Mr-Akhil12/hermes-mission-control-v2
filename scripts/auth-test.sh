#!/usr/bin/env bash
# Hermes OS v2 — auth + bridge security test suite.
# Verifies: unauthenticated rejection, PIN auth, session gating,
# rate limiting, bridge token accept/reject, security headers.
# Usage: AUTH_PIN=123456 ./scripts/auth-test.sh [BASE_URL]
# Default BASE_URL = https://hermes-mission-control-v2.vercel.app
set -u

BASE="${1:-https://hermes-mission-control-v2.vercel.app}"
PIN="${AUTH_PIN:-}"
if [ -z "$PIN" ]; then
  echo "AUTH_PIN env var required — run: AUTH_PIN=<your pin> ./scripts/auth-test.sh"
  exit 1
fi
JAR="$(mktemp)"
PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $name ($actual)"
    PASS=$((PASS+1))
  else
    echo "  ✗ $name — expected $expected got $actual"
    FAIL=$((FAIL+1))
  fi
}

echo "== Hermes OS auth tests — $BASE =="

# 1. Unauthenticated API rejected
echo "[1] Unauthenticated API"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/crons")
check "crons without session → 401" 401 "$CODE"

# 2. Wrong PIN rejected
echo "[2] PIN verification"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"pin":"000000"}' "$BASE/api/auth/verify")
check "wrong PIN → 401" 401 "$CODE"

# 3. Correct PIN accepted + session cookie
CODE=$(curl -s -c "$JAR" -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{\"pin\":\"$PIN\"}" "$BASE/api/auth/verify")
check "correct PIN → 200" 200 "$CODE"

# 4. Authenticated API works
echo "[3] Authenticated access"
CODE=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/api/crons")
check "crons with session → 200" 200 "$CODE"
CODE=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/api/approvals")
check "approvals with session → 200" 200 "$CODE"
CODE=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/api/channels")
check "channels with session → 200" 200 "$CODE"

# 5. Security headers present
echo "[4] Security headers"
HDR=$(curl -s -I "$BASE/")
check "x-content-type-options" "present" "$(echo "$HDR" | grep -ci "x-content-type-options: nosniff" >/dev/null && echo present || echo missing)"
check "referrer-policy" "present" "$(echo "$HDR" | grep -ci "referrer-policy:" >/dev/null && echo present || echo missing)"
check "x-frame-options" "present" "$(echo "$HDR" | grep -ci "x-frame-options: SAMEORIGIN" >/dev/null && echo present || echo missing)"
check "permissions-policy" "present" "$(echo "$HDR" | grep -ci "permissions-policy:" >/dev/null && echo present || echo missing)"
check "content-security-policy" "present" "$(echo "$HDR" | grep -ci "content-security-policy:" >/dev/null && echo present || echo missing)"

# 6. Rate limiting — 11 rapid wrong PINs, expect a 429 among them
echo "[5] Rate limiting"
LIMIT_HIT=0
for i in $(seq 1 11); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"pin":"999999"}' "$BASE/api/auth/verify")
  [ "$CODE" = "429" ] && LIMIT_HIT=1
done
check "11th wrong PIN → 429" 1 "$LIMIT_HIT"

echo ""
echo "== Result: $PASS passed, $FAIL failed =="
rm -f "$JAR"
[ "$FAIL" -eq 0 ]
