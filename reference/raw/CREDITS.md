# Reference photographs — provenance and licensing

The blind comparison in `AGENTS.md` uses photographs from the
[MSX Wiki](https://www.msx.org/wiki/Gradiente_Expert_XP-800). Each image has its own
license; this repository ships only images explicitly licensed for redistribution.

## Shipped in this repository — CC BY 3.0

Each file page declares [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/):

| File | Author | Source |
|---|---|---|
| `Expert_Box.jpg` | Mars2000you | [MSX Wiki](https://www.msx.org/wiki/File:Expert_Box.jpg) |
| `Expert_Extras.jpg` | Mars2000you | [MSX Wiki](https://www.msx.org/wiki/File:Expert_Extras.jpg) |
| `Gradiente_expert_XP-800_back.jpg` | Mars2000you | [MSX Wiki](https://www.msx.org/wiki/File:Gradiente_expert_XP-800_back.jpg) |

## Not shipped — fetch locally before a visual review

These files claim uploader ownership or provide no license grant. They are treated as all
rights reserved, excluded from Git, and fetched only for local comparison.

| File | Author | Source |
|---|---|---|
| `CF3000_and_XP800.jpg` | Mars2000you | [MSX Wiki](https://www.msx.org/wiki/File:CF3000_and_XP800.jpg) |
| `Gradiente_expert_XP-800_keyboard_correct.jpg` | Mars2000you | [MSX Wiki](https://www.msx.org/wiki/File:Gradiente_expert_XP-800_keyboard_correct.jpg) |
| `Gradiente_Logo_Detail.jpg` | Wernerkai | [MSX Wiki](https://www.msx.org/wiki/File:Gradiente_Logo_Detail.jpg) |
| `Xp800easter.png` | Mars2000you | [MSX Wiki](https://www.msx.org/wiki/File:Xp800easter.png) |

To fetch them into this directory:

```bash
cd reference/raw
for f in CF3000_and_XP800.jpg Gradiente_expert_XP-800_keyboard_correct.jpg \
         Gradiente_Logo_Detail.jpg Xp800easter.png; do
  curl -fL -A "msx-expert-xp800/reference-fetch" -o "$f" \
    "https://www.msx.org/wiki/Special:Redirect/file/$f"
done
```

`docs/SPEC.md` records every derived measurement, so these files are needed only to rerun
visual comparisons or measurements.

MSX is a trademark of MSX Licensing Corporation. Gradiente and Expert are trademarks of
their respective owners. This project is a tribute, not an official product.
