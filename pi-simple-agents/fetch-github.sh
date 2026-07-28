#!/usr/bin/env bash
# Fetch the raw file from GitHub for v0.2.2
curl -sL "https://raw.githubusercontent.com/pablo-ipsense/pi-simple-agents/refs/tags/v0.2.2/src/agents.ts" 2>/dev/null || echo "curl not available or failed"