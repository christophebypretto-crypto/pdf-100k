import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import { countRemovableText, removeTextByContent } from '../../lib/contentTextRemoval'

interface Props {
  pdfBytes: ArrayBuffer
  onClose: () => void
  onDone: (newBytes: ArrayBuffer, removedCount: number) => void
}

export default function RemoveTextDialog({ pdfBytes, onClose, onDone }: Props): JSX.Element {
  const [text, setText] = useState('BROUILLON')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewPages, setPreviewPages] = useState<number[]>([])
  const [samples, setSamples] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-preview à chaque changement de texte
  useEffect(() => {
    let cancelled = false
    if (!text.trim()) {
      setPreviewCount(null)
      setSamples([])
      return
    }
    const handle = setTimeout(async () => {
      try {
        const r = await countRemovableText(pdfBytes, text, { caseSensitive })
        if (!cancelled) {
          setPreviewCount(r.count)
          setPreviewPages(r.pagesAffected)
          setSamples(r.samples)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erreur de recherche')
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [text, caseSensitive, pdfBytes])

  async function doRemove(): Promise<void> {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await removeTextByContent(pdfBytes, text, { caseSensitive })
      if (r.removed === 0) {
        setError(
          "Rien n'a pu être supprimé sans emporter du texte voisin. Le PDF n'a pas été modifié."
        )
        return
      }
      onDone(r.bytes, r.removed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Supprimer un texte récurrent (filigrane, mention…)"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button onClick={onClose} className="px-4 py-2 rounded-md hover:bg-black/5 text-black/70">
            Annuler
          </button>
          <button
            onClick={doRemove}
            disabled={busy || !text.trim() || previewCount === 0}
            className="px-4 py-2 rounded-md bg-pretto text-white font-medium disabled:opacity-40 hover:bg-pretto/90"
          >
            {busy
              ? 'Suppression…'
              : previewCount && previewCount > 0
                ? `Supprimer ${previewCount} occurrence${previewCount > 1 ? 's' : ''}`
                : 'Supprimer'}
          </button>
        </>
      }
    >
      <p className="text-sm text-black/60 mb-3">
        Le texte est <strong>réellement retiré</strong> du PDF : il n'est plus affiché, plus
        sélectionnable, plus copiable — aucun rectangle blanc n'est posé par-dessus, donc ce qu'il y
        a derrière (tableaux, texte, images) réapparaît intact. Idéal pour les filigranes{' '}
        <strong>BROUILLON</strong>, <strong>DRAFT</strong>, <strong>COPIE</strong>.
      </p>
      <label className="block text-sm font-medium mb-1">Texte à supprimer</label>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ex : BROUILLON"
        className="w-full px-3 py-2 border border-black/15 rounded-md font-mono focus:outline-none focus:border-pretto"
      />
      <label className="flex items-center gap-2 mt-3 text-sm text-black/70">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(e) => setCaseSensitive(e.target.checked)}
          className="accent-pretto"
        />
        Respecter la casse (sinon BROUILLON et brouillon sont équivalents)
      </label>
      {previewCount !== null && (
        <div
          className={[
            'mt-4 p-3 rounded-md text-sm',
            previewCount === 0
              ? 'bg-black/5 text-black/60'
              : 'bg-pretto/10 text-pretto border border-pretto/20'
          ].join(' ')}
        >
          {previewCount === 0 ? (
            <span>Aucune occurrence trouvée.</span>
          ) : (
            <>
              <strong>
                {previewCount} occurrence{previewCount > 1 ? 's' : ''}
              </strong>{' '}
              trouvée{previewCount > 1 ? 's' : ''} sur{' '}
              <strong>
                {previewPages.length} page{previewPages.length > 1 ? 's' : ''}
              </strong>
              {previewPages.length <= 10 && (
                <>
                  {' '}
                  (page{previewPages.length > 1 ? 's' : ''}{' '}
                  {previewPages.map((p) => p + 1).join(', ')})
                </>
              )}
              .
            </>
          )}
        </div>
      )}
      {/* Un PDF dessine souvent une ligne entière d'un seul tenant : on montre
          exactement ce qui va disparaître avant de lancer la suppression. */}
      {samples.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-black/70 mb-1">Ce qui sera supprimé :</div>
          <ul className="max-h-32 overflow-y-auto rounded-md border border-black/10 divide-y divide-black/5">
            {samples.map((s, i) => (
              <li key={i} className="px-3 py-1.5 text-xs font-mono text-black/70 truncate" title={s}>
                {s.length > 120 ? s.slice(0, 120) + '…' : s}
              </li>
            ))}
          </ul>
          <p className="text-xs text-black/40 mt-2">
            Si un extrait contient plus que le mot cherché, c'est que le PDF dessine toute la ligne
            d'un bloc : elle partirait en entier. Précise ta recherche dans ce cas.
          </p>
        </div>
      )}
      {error && <div className="mt-3 p-3 rounded-md bg-red-50 text-red-700 text-sm">{error}</div>}
    </Dialog>
  )
}
