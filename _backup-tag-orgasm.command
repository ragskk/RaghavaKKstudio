#!/bin/bash
cd "$(dirname "$0")"
git tag backup-2026-08-20-pre-orgasm-dossier
git push origin backup-2026-08-20-pre-orgasm-dossier
echo "Tag created and pushed."
read -p "Press enter to close"
