#!/bin/bash
head -5 README.md
echo "---"
grep -n "AgentConfig" README.md 2>/dev/null | head -5