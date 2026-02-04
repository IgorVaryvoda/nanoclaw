#!/bin/bash
# Sync Claude OAuth token and credentials from local Claude to NanoClaw containers

set -e

# Refresh token by running claude
claude -p "ping" --max-turns 1 > /dev/null 2>&1 || true

CREDS_FILE="$HOME/.claude/.credentials.json"
DATA_DIR="/home/igor/Projects/nanoclaw/data"
ENV_FILE="$DATA_DIR/env/env"
SESSIONS_DIR="$DATA_DIR/sessions"

if [[ ! -f "$CREDS_FILE" ]]; then
    echo "Credentials file not found: $CREDS_FILE"
    exit 1
fi

# Sync OAuth token to env file (used by entrypoint)
TOKEN=$(jq -r '.claudeAiOauth.accessToken' "$CREDS_FILE" 2>/dev/null)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
    echo "Could not extract token from credentials"
    exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" > "$ENV_FILE"

# Sync credentials file to all group session directories
for group_dir in "$SESSIONS_DIR"/*/; do
    if [[ -d "$group_dir" ]]; then
        group_name=$(basename "$group_dir")
        claude_dir="$group_dir/.claude"
        mkdir -p "$claude_dir"
        cp "$CREDS_FILE" "$claude_dir/.credentials.json"
        echo "Synced credentials to $group_name"
    fi
done

echo "Token synced: ${TOKEN:0:25}..."
