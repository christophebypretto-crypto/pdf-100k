import { useEffect, useState } from 'react'

/**
 * Version installée, épinglée en haut à droite de la barre d'outils (Mac et Windows).
 *
 * Sert à lever le doute avant de signaler un problème : on voit tout de suite si
 * le poste tourne bien la dernière version. La valeur vient de `app.getVersion()`
 * dans le process principal — donc du binaire réellement en train de tourner, et
 * non d'une constante figée à la compilation.
 *
 * Choix de mise en oeuvre :
 * - position absolue plutôt que dans le flux de la barre : sur une fenêtre
 *   étroite (minWidth 1000) le contenu de la barre déborde, et la version se
 *   retrouverait hors écran — c'est-à-dire exactement quand on en a besoin ;
 * - fond opaque, pour rester lisible si un bouton passe dessous ;
 * - `pointer-events-none`, pour ne JAMAIS voler le clic du bouton qu'elle
 *   recouvre en cas de débordement (au prix de l'infobulle, que le texte affiché
 *   rend de toute façon superflue).
 *
 * Reste masquée par les calques plein écran (Comptes miroir, boîtes de dialogue) :
 * ce sont des modes temporaires dont on sort pour lire la barre d'outils.
 */
export default function AppVersion(): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      ?.getAppVersion?.()
      .then((v) => {
        if (!cancelled) setVersion(v)
      })
      .catch(() => {
        /* IPC en échec : on n'affiche rien plutot qu'une valeur fausse */
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!version) return null

  return (
    <span className="pointer-events-none absolute right-3 top-3 z-30 select-none whitespace-nowrap rounded bg-white/95 px-2 py-0.5 font-mono text-xs tabular-nums text-black/60 shadow-sm ring-1 ring-black/5">
      v{version}
    </span>
  )
}
