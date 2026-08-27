import { useEffect, useRef, useState } from 'react'
import { Tool } from './Sidebar'
import AppVersion from './AppVersion'
import { loadImageFile, LoadedImage } from '../lib/imageImport'

interface Props {
  filePath: string | null
  dirty: boolean
  busy: boolean
  hasDoc: boolean
  tool: Tool
  numPages: number
  currentPage: number
  scale: number
  highlightColor: string
  highlightOpacity: number
  highlightMode: 'shape' | 'text'
  penColor: string
  penWidth: number
  textSize: number
  textColor: string
  signatureDataUrl: string | null
  onOpen: () => void
  onNew: () => void
  recentFiles: string[]
  onOpenRecent: (path: string) => void
  onClearRecent: () => void
  onSave: () => void
  onSaveAs: () => void
  onMerge: () => void
  onSplit: () => void
  onExtract: () => void
  onOrganize: () => void
  organizeActive: boolean
  onZoom: (delta: number | 'fit') => void
  onSetHighlightColor: (c: string) => void
  onSetHighlightOpacity: (n: number) => void
  onSetHighlightMode: (m: 'shape' | 'text') => void
  onSetPenColor: (c: string) => void
  onSetPenWidth: (n: number) => void
  onSetTextSize: (n: number) => void
  onSetTextColor: (c: string) => void
  onCreateSignature: () => void
  onClearSignature: () => void
  pendingImage: LoadedImage | null
  onImageChosen: (img: LoadedImage) => void
  onClearImage: () => void
  onOpenRemoveTextDialog: () => void
  onUndo: () => void
  hasAnnotations: boolean
  formFieldsCount: number
  onOpenMirror: () => void
  onCloseMirror: () => void
  mirrorActive: boolean
  lastSavedAt: number | null
}

function shortName(path: string | null): string {
  if (!path) return 'Aucun document'
  return path.split('/').pop() || path
}

/** Pour les chemins longs : "Users › q › Documents › … › facture.pdf" */
function midEllipsisPath(path: string | null, max = 70): string {
  if (!path) return ''
  if (path.length <= max) return path
  const head = path.slice(0, Math.floor(max / 2) - 2)
  const tail = path.slice(-Math.floor(max / 2) + 2)
  return `${head}…${tail}`
}

const HIGHLIGHT_COLORS = ['#FFF200', '#A6E22E', '#FF7AC6', '#5AC8FA', '#FF9500']
const PEN_COLORS = ['#1A1A1A', '#0C806E', '#E11D48', '#0EA5E9', '#F59E0B']

export default function Toolbar(p: Props): JSX.Element {
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const cls =
    'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border border-transparent'
  const primary = `${cls} bg-pretto text-white hover:bg-pretto/90`
  const ghost = `${cls} text-ink hover:bg-black/5`
  const ghostDisabled = `${cls} text-black/30 cursor-not-allowed`
  const can = (need: boolean) => (need ? ghost : ghostDisabled)

  const [recentOpen, setRecentOpen] = useState(false)
  const recentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!recentOpen) return
    const onDown = (e: MouseEvent): void => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) setRecentOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [recentOpen])

  return (
    <header className="relative shrink-0 bg-white border-b border-black/10">
      {/* Version installee, epinglee en haut a droite (cf. AppVersion) */}
      <AppVersion />
      {/* Ligne 1 : fichier + ops PDF + zoom — pr-24 reserve la place de la pastille de version */}
      <div className="h-12 flex items-center px-3 pr-24 gap-2">
        <button
          onClick={p.onNew}
          className={primary}
          disabled={p.busy}
          title="Démarrer un nouveau document PDF vierge (⌘N)"
        >
          ＋ Nouveau
        </button>
        <button onClick={p.onOpen} className={ghost} disabled={p.busy} title="Ouvrir un PDF (⌘O)">
          Ouvrir
        </button>

        {/* Récents : menu déroulant */}
        <div className="relative" ref={recentRef}>
          <button
            onClick={() => setRecentOpen((v) => !v)}
            disabled={p.busy || p.recentFiles.length === 0}
            className={p.recentFiles.length === 0 ? ghostDisabled : ghost}
            title="Rouvrir un fichier récent"
          >
            Récents ▾
          </button>
          {recentOpen && p.recentFiles.length > 0 && (
            <div className="absolute left-0 top-full mt-1 z-50 w-80 bg-white border border-black/15 rounded-lg shadow-xl py-1 max-h-96 overflow-auto">
              {p.recentFiles.map((path) => {
                const name = path.split(/[/\\]/).pop() || path
                const dir = path.slice(0, path.length - name.length).replace(/[/\\]$/, '')
                return (
                  <button
                    key={path}
                    onClick={() => {
                      setRecentOpen(false)
                      p.onOpenRecent(path)
                    }}
                    title={path}
                    className="w-full text-left px-3 py-1.5 hover:bg-pretto/5 flex flex-col"
                  >
                    <span className="text-sm text-ink truncate">{name}</span>
                    <span className="text-[11px] text-black/40 truncate">{dir}</span>
                  </button>
                )
              })}
              <div className="border-t border-black/10 mt-1 pt-1">
                <button
                  onClick={() => {
                    setRecentOpen(false)
                    p.onClearRecent()
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/5"
                >
                  Vider la liste des récents
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={p.onSave}
          className={can(p.hasDoc)}
          disabled={!p.hasDoc || p.busy}
          title={
            p.filePath
              ? `Enregistrer en remplacement du fichier original :\n${p.filePath}`
              : 'Enregistrer le PDF (choisira un emplacement)'
          }
        >
          Enregistrer{p.filePath ? ' (remplace l’original)' : '…'}
        </button>
        <button
          onClick={p.onSaveAs}
          className={can(p.hasDoc)}
          disabled={!p.hasDoc || p.busy}
          title="Enregistrer une COPIE dans un nouveau fichier (l'original n'est pas modifié)"
        >
          Enregistrer sous…
        </button>

        <div className="w-px h-6 bg-black/10 mx-1" />

        <button onClick={p.onMerge} className={ghost}>
          Fusionner
        </button>
        <button onClick={p.onSplit} className={can(p.hasDoc)} disabled={!p.hasDoc || p.busy}>
          Diviser
        </button>
        <button onClick={p.onExtract} className={can(p.hasDoc)} disabled={!p.hasDoc || p.busy}>
          Extraire
        </button>
        <button
          onClick={p.onOrganize}
          disabled={!p.hasDoc || p.busy}
          className={[
            cls,
            !p.hasDoc
              ? 'text-black/30 cursor-not-allowed'
              : p.organizeActive
                ? 'bg-pretto text-white hover:bg-pretto/90'
                : 'text-ink hover:bg-black/5'
          ].join(' ')}
          title="Vue grille des pages : réorganiser, pivoter, supprimer, insérer"
        >
          ▦ {p.organizeActive ? 'Quitter Organiser' : 'Organiser'}
        </button>

        <div className="w-px h-6 bg-black/10 mx-1" />

        <button
          onClick={p.mirrorActive ? p.onCloseMirror : p.onOpenMirror}
          disabled={!p.hasDoc || p.busy}
          className={[
            cls,
            !p.hasDoc
              ? 'text-black/30 cursor-not-allowed'
              : p.mirrorActive
                ? 'bg-olive text-white hover:bg-olive/90'
                : 'text-ink hover:bg-black/5'
          ].join(' ')}
          title="Comparer 2 relevés côte à côte et surligner les virements miroirs"
        >
          ⇄ {p.mirrorActive ? 'Fermer la comparaison' : 'Comptes miroir'}
        </button>

        <div className="w-px h-6 bg-black/10 mx-1" />

        <button
          onClick={p.onUndo}
          className={can(p.hasAnnotations)}
          disabled={!p.hasAnnotations || p.busy}
          title="Annuler la dernière annotation"
        >
          ↶ Annuler
        </button>

        {/* Zoom group */}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => p.onZoom(-0.25)}
            disabled={!p.hasDoc}
            className={can(p.hasDoc) + ' w-9'}
            title="Réduire"
          >
            −
          </button>
          <span className="text-xs text-black/60 w-12 text-center">
            {Math.round(p.scale * 100)}%
          </span>
          <button
            onClick={() => p.onZoom(0.25)}
            disabled={!p.hasDoc}
            className={can(p.hasDoc) + ' w-9'}
            title="Agrandir"
          >
            +
          </button>
          <button
            onClick={() => p.onZoom('fit')}
            disabled={!p.hasDoc}
            className={can(p.hasDoc)}
            title="Ajuster à la largeur"
          >
            Ajuster
          </button>
        </div>
      </div>

      {/* Ligne 2 : options de l'outil actif */}
      {p.hasDoc && (
        <div className="h-11 flex items-center px-3 gap-3 bg-cream/60 border-t border-black/5 text-sm">
          {p.tool === 'pages' && (
            <div className="text-black/60">
              Page <strong>{p.currentPage + 1}</strong> / {p.numPages} · Clique une miniature à gauche pour
              naviguer · Clic-droit pour pivoter/supprimer/insérer
            </div>
          )}
          {p.tool === 'annotate-highlight' && (
            <>
              {/* Toggle mode shape vs texte */}
              <div className="flex bg-white border border-black/15 rounded-md overflow-hidden">
                <button
                  onClick={() => p.onSetHighlightMode('text')}
                  className={[
                    'px-2 py-1 text-xs font-medium',
                    p.highlightMode === 'text' ? 'bg-pretto text-white' : 'text-black/60 hover:bg-black/5'
                  ].join(' ')}
                  title="Surligne uniquement le texte sélectionné"
                >
                  Texte
                </button>
                <button
                  onClick={() => p.onSetHighlightMode('shape')}
                  className={[
                    'px-2 py-1 text-xs font-medium border-l border-black/10',
                    p.highlightMode === 'shape' ? 'bg-pretto text-white' : 'text-black/60 hover:bg-black/5'
                  ].join(' ')}
                  title="Dessine un rectangle libre"
                >
                  Forme
                </button>
              </div>

              <span className="text-black/60 ml-2">Couleur :</span>
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => p.onSetHighlightColor(c)}
                  className={[
                    'w-7 h-7 rounded border',
                    p.highlightColor === c ? 'border-ink ring-2 ring-pretto/40' : 'border-black/15'
                  ].join(' ')}
                  style={{ backgroundColor: c }}
                />
              ))}

              <span className="ml-3 text-black/60">Intensité :</span>
              <input
                type="range"
                min={0.1}
                max={0.8}
                step={0.05}
                value={p.highlightOpacity}
                onChange={(e) => p.onSetHighlightOpacity(parseFloat(e.target.value))}
                className="w-28 accent-pretto"
              />
              <span className="text-xs text-black/50 w-9">
                {Math.round(p.highlightOpacity * 100)}%
              </span>

              <span className="ml-2 text-xs text-black/50">
                {p.highlightMode === 'text'
                  ? 'Sélectionne du texte → surligné automatiquement'
                  : 'Glisse pour dessiner un rectangle libre'}
              </span>
            </>
          )}
          {p.tool === 'annotate-pen' && (
            <>
              <span className="text-black/60">Couleur :</span>
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => p.onSetPenColor(c)}
                  className={[
                    'w-7 h-7 rounded-full border',
                    p.penColor === c ? 'border-ink ring-2 ring-pretto/40' : 'border-black/15'
                  ].join(' ')}
                  style={{ backgroundColor: c }}
                />
              ))}
              <span className="ml-3 text-black/60">Épaisseur :</span>
              <input
                type="range"
                min={1}
                max={10}
                value={p.penWidth}
                onChange={(e) => p.onSetPenWidth(parseInt(e.target.value, 10))}
                className="w-32 accent-pretto"
              />
              <span className="text-xs text-black/50 w-6">{p.penWidth}</span>
            </>
          )}
          {p.tool === 'annotate-text' && (
            <>
              <span className="text-black/60">Couleur :</span>
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => p.onSetTextColor(c)}
                  className={[
                    'w-7 h-7 rounded border',
                    p.textColor === c ? 'border-ink ring-2 ring-pretto/40' : 'border-black/15'
                  ].join(' ')}
                  style={{ backgroundColor: c }}
                />
              ))}
              <span className="ml-3 text-black/60">Taille :</span>
              <input
                type="number"
                min={6}
                max={48}
                value={p.textSize}
                onChange={(e) => p.onSetTextSize(parseInt(e.target.value, 10) || 12)}
                className="w-16 px-2 py-1 border border-black/15 rounded text-sm"
              />
              <span className="ml-3 text-xs text-black/50">Clique sur le document pour ajouter du texte</span>
            </>
          )}
          {p.tool === 'ocr' && (
            <div className="text-black/60">
              Panneau OCR ouvert à droite · Choisis "Page courante" ou "Tout le PDF recherchable"
            </div>
          )}
          {p.tool === 'form-text' && (
            <div className="text-black/60">
              <strong>Glisse sur le document</strong> pour dessiner un champ texte ·
              {p.formFieldsCount > 0 && (
                <span className="ml-2 text-pretto font-medium">
                  {p.formFieldsCount} champ{p.formFieldsCount > 1 ? 's' : ''} dans le doc
                </span>
              )}
              <span className="ml-2 text-xs">Survole un champ existant pour le supprimer</span>
            </div>
          )}
          {p.tool === 'form-checkbox' && (
            <div className="text-black/60">
              <strong>Glisse sur le document</strong> pour dessiner une case à cocher
              {p.formFieldsCount > 0 && (
                <span className="ml-2 text-pretto font-medium">
                  {p.formFieldsCount} champ{p.formFieldsCount > 1 ? 's' : ''} dans le doc
                </span>
              )}
            </div>
          )}
          {p.tool === 'modify-text' && (
            <div className="text-black/60">
              <strong>Clique sur un texte du PDF</strong> pour le modifier · police, taille et style
              sont automatiquement repris ·{' '}
              <span className="text-xs">
                limite : si la police originale est exotique, le rendu utilise une police standard équivalente
                (Helvetica/Times/Courier)
              </span>
            </div>
          )}
          {p.tool === 'eraser' && (
            <>
              <span className="text-black/60">
                Glisse pour dessiner un rectangle blanc qui recouvre du contenu (redaction manuelle)
              </span>
              <div className="w-px h-5 bg-black/10 mx-1" />
              <button onClick={p.onOpenRemoveTextDialog} className={primary}>
                Supprimer un texte récurrent…
              </button>
              <span className="text-xs text-black/50">
                (Watermark BROUILLON, DRAFT, COPY…)
              </span>
            </>
          )}
          {p.tool === 'image' && (
            <>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = '' // reprendre le meme fichier doit re-declencher
                  if (!file) return
                  try {
                    setImageError(null)
                    p.onImageChosen(await loadImageFile(file))
                  } catch (err) {
                    setImageError(err instanceof Error ? err.message : "Image illisible")
                  }
                }}
              />
              {p.pendingImage ? (
                <>
                  <span className="text-black/60">Image prête :</span>
                  <img
                    src={p.pendingImage.dataUrl}
                    alt=""
                    className="h-10 bg-white border border-black/10 rounded px-1 object-contain"
                  />
                  <span className="text-xs text-black/45">
                    {p.pendingImage.width} × {p.pendingImage.height} px
                  </span>
                  <button
                    onClick={() => imageInputRef.current?.click()}
                    className="text-xs text-pretto hover:underline"
                  >
                    Changer
                  </button>
                  <button onClick={p.onClearImage} className="text-xs text-red-500 hover:underline">
                    Retirer
                  </button>
                  <span className="ml-2 text-xs text-black/50">
                    Clique sur le document pour la poser · ensuite glisse-la, tire le coin pour
                    l'agrandir, la poignée du haut pour la pivoter
                  </span>
                </>
              ) : (
                <>
                  <button onClick={() => imageInputRef.current?.click()} className={primary}>
                    Choisir une image…
                  </button>
                  <span className="text-xs text-black/50">PNG, JPEG, WebP, GIF ou BMP</span>
                </>
              )}
              {imageError && <span className="text-xs text-red-600">{imageError}</span>}
            </>
          )}

          {p.tool === 'sign' && (
            <>
              {p.signatureDataUrl ? (
                <>
                  <span className="text-black/60">Signature prête :</span>
                  <img
                    src={p.signatureDataUrl}
                    alt="Signature"
                    className="h-10 bg-white border border-black/10 rounded px-1"
                  />
                  <button onClick={p.onCreateSignature} className="text-xs text-pretto hover:underline">
                    Changer
                  </button>
                  <button onClick={p.onClearSignature} className="text-xs text-red-500 hover:underline">
                    Retirer
                  </button>
                  <span className="ml-2 text-xs text-black/50">Clique sur le document pour placer la signature</span>
                </>
              ) : (
                <>
                  <button onClick={p.onCreateSignature} className={primary}>
                    Créer ma signature
                  </button>
                  <span className="text-xs text-black/50">Dessiner, importer une image ou taper</span>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Statut document */}
      <div className="h-7 flex items-center px-3 gap-3 text-xs text-black/55 border-t border-black/5 bg-white">
        {p.busy && <span className="text-pretto">Traitement…</span>}
        {p.dirty && !p.lastSavedAt && (
          <span className="text-olive">●&nbsp;Modifications non enregistrées</span>
        )}
        {p.lastSavedAt && p.filePath && (
          <button
            onClick={() => window.api.showInFolder(p.filePath!)}
            className="text-pretto font-semibold hover:underline cursor-pointer"
            title="Ouvrir le dossier dans le Finder / Explorateur"
          >
            ✓ Enregistré dans : {p.filePath} — clic pour ouvrir le dossier
          </button>
        )}
        {p.filePath ? (
          <button
            onClick={() => window.api.showInFolder(p.filePath!)}
            className="ml-auto max-w-[60vw] truncate text-left hover:underline cursor-pointer"
            title={`Clic pour ouvrir le dossier dans le Finder / Explorateur :\n${p.filePath}`}
          >
            <span className="text-black/45">Fichier : </span>
            <span className="font-medium text-black/75">{midEllipsisPath(p.filePath)}</span>
          </button>
        ) : (
          <span className="ml-auto text-black/45">Aucun fichier ouvert</span>
        )}
      </div>
    </header>
  )
}
