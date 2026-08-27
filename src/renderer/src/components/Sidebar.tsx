export type Tool =
  | 'pages'
  | 'annotate-highlight'
  | 'annotate-pen'
  | 'annotate-text'
  | 'modify-text'
  | 'sign'
  | 'image'
  | 'eraser'
  | 'ocr'
  | 'form-text'
  | 'form-checkbox'

interface ToolDef {
  id: Tool
  label: string
  icon: string
  hint?: string
  disabled?: boolean
}

// "Organiser" (vue grille des pages) est maintenant dans la Toolbar en haut,
// à côté de Fusionner / Diviser / Extraire.
const TOOLS: ToolDef[] = [
  { id: 'annotate-highlight', label: 'Surligner', icon: '▭', hint: 'Glisser pour surligner' },
  { id: 'annotate-pen', label: 'Crayon', icon: '✎', hint: 'Dessiner à main levée' },
  { id: 'annotate-text', label: 'Texte', icon: 'T', hint: 'Clique pour ajouter du texte' },
  {
    id: 'modify-text',
    label: 'Modifier',
    icon: '✎T',
    hint: 'Clique sur un texte existant pour le modifier (police/taille reprises)'
  },
  { id: 'sign', label: 'Signature', icon: '✍', hint: 'Dessiner ou importer une signature' },
  {
    id: 'image',
    label: 'Image',
    icon: '🖼',
    hint: 'Insérer une image (PNG/JPEG) : déplaçable, redimensionnable, pivotable'
  },
  {
    id: 'eraser',
    label: 'Effacer',
    icon: '⌫',
    hint: 'Recouvrir une zone (rectangle blanc) ou supprimer un texte récurrent (watermark)'
  },
  { id: 'ocr', label: 'OCR', icon: '⚙', hint: 'Reconnaître le texte (Tesseract local)' },
  { id: 'form-text', label: 'Champ texte', icon: '◳', hint: 'Drag pour créer un champ à remplir' },
  { id: 'form-checkbox', label: 'Case', icon: '☐', hint: 'Drag pour créer une case à cocher' }
]

interface Props {
  active: Tool
  onChange: (t: Tool) => void
  hasDoc: boolean
}

export default function Sidebar({ active, onChange, hasDoc }: Props): JSX.Element {
  return (
    <aside className="w-20 shrink-0 bg-white border-r border-black/10 flex flex-col items-center py-3 gap-1 overflow-y-auto">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          disabled={t.disabled || !hasDoc}
          onClick={() => onChange(t.id)}
          title={t.hint}
          className={[
            'w-16 h-14 shrink-0 rounded-lg flex flex-col items-center justify-center text-[10px] font-medium gap-0.5 transition-colors',
            t.disabled || !hasDoc
              ? 'text-black/30 cursor-not-allowed'
              : active === t.id
                ? 'bg-pretto text-white shadow-sm'
                : 'text-black/70 hover:bg-black/5'
          ].join(' ')}
        >
          <span className="text-lg leading-none">{t.icon}</span>
          <span className="text-center leading-tight">{t.label}</span>
        </button>
      ))}
    </aside>
  )
}
