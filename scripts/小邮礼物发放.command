#!/bin/zsh
cd "${0:A:h}/.." || exit 1
if [[ -x .venv-build/bin/python ]]; then
  .venv-build/bin/python scripts/companion_gift_issuer.py gui
else
  python3 scripts/companion_gift_issuer.py gui
fi
