#!/bin/bash
git checkout README.md 2>/dev/null && echo "Restored README.md" || echo "Failed to restore"