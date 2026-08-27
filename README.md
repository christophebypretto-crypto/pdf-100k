# PDF 100K

Éditeur PDF interne pour l'équipe Pretto Galaxie. Alternative gratuite à Wondershare PDF Element.

**Stack** : Electron 33 + React 18 + TypeScript + Tailwind. Libs PDF : `pdf-lib`, `pdfjs-dist`, `tesseract.js`.

## Fonctionnalités

- Gestion des pages : fusion, division, réorganiser, pivoter, supprimer, insérer/extraire, ajouter PDF à la suite
- Annotations : surlignage (forme libre ou par sélection de texte), crayon, texte avec taille ajustable, signatures (dessinées / importées / tapées)
- Drag, redimensionnement, copier/coller/couper/dupliquer/supprimer (boutons + clic-droit + raccourcis)
- OCR Tesseract local gratuit (FR + EN) — page entière, zone à dessiner, ou tout le PDF en recherchable
- OCR + texte modifiable : crée des annotations éditables par-dessus le scan
- Images : insérer un PNG/JPEG (ou WebP/GIF/BMP, re-encodés) depuis le disque — déplaçable, redimensionnable à ratio constant, rotation libre à la souris (Maj = par pas de 15°) ou par pas de 90° au clic droit
- Formulaires : champs texte et cases à cocher embarqués en AcroForm
- Suppression réelle de texte : l'outil Modifier et la boîte « Supprimer un texte récurrent » retirent le texte du flux de contenu du PDF (filigrane BROUILLON, mention obsolète…) au lieu de poser un rectangle blanc dessus — ce qu'il y a derrière reste intact, et le texte n'est plus ni affiché ni copiable
- Sauvegarde directe sur le fichier d'origine ou Enregistrer sous

## Développement

```bash
npm install
npm run dev       # mode dev avec HMR
npm start         # preview production
npm run build     # build sans packager
npm run build:mac # .dmg Apple Silicon
npm run build:win # .exe Windows
```

## Distribution équipe

Les binaires sont publiés via [GitHub Releases](../../releases). L'auto-update est intégré : les apps installées vérifient au démarrage et proposent la dernière version.

> Le build Mac produit **deux** fichiers : le `.dmg` (installation manuelle) et le `.zip` (mise à jour automatique). Le `.zip` est obligatoire — Squirrel.Mac ne sait pas appliquer un `.dmg`. Sans lui, l'auto-update échoue en silence sur tous les Mac (c'était le cas jusqu'en 0.3.16).

### Pour installer sur un nouveau poste

- **Mac (Apple Silicon)** : télécharger le `.dmg`, glisser PDF 100K dans Applications, première ouverture en clic-droit → Ouvrir
- **Windows** : télécharger le `Setup.exe`, lancer, "Informations complémentaires" → "Exécuter quand même"

## Architecture

- `src/main/` — process Electron principal (Node.js)
- `src/preload/` — pont contextIsolation
- `src/renderer/` — UI React (Tailwind)
- `src/renderer/src/lib/` — manipulation PDF (pdf-lib), rendu (pdfjs), OCR (Tesseract), recherchable, formulaires
