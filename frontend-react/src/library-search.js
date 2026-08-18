// Lightweight iPod-library search enhancer. It deliberately lives outside the
// main App component so the existing iPod navigation/wheel behaviour is left
// untouched. It filters the currently loaded library instantly on the device.

const STYLE_ID = 'library-search-style'
const BAR_ID = 'library-search-bar'

function installStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `#${BAR_ID}{padding:7px 8px;border-bottom:1px solid #aaa;background:linear-gradient(#f8f8f8,#d8d8d8);position:sticky;top:0;z-index:2}#${BAR_ID} input{width:100%;border:1px solid #888;border-radius:4px;padding:6px 8px;background:#fff;font:12px Arial,Helvetica,sans-serif;outline:none}#${BAR_ID} input:focus{box-shadow:inset 0 0 0 1px #555}`
  document.head.appendChild(style)
}

function isLibraryScreen() {
  const top = document.querySelector('.screen-top span')
  return top?.textContent?.trim().toLowerCase() === 'library'
}

function filterRows(value) {
  const query = value.trim().toLowerCase()
  document.querySelectorAll('.screen-body .track-line').forEach(row => {
    const text = row.textContent.toLowerCase()
    row.style.display = !query || text.includes(query) ? '' : 'none'
  })
}

function ensureBar() {
  const body = document.querySelector('.screen-body')
  if (!body || !isLibraryScreen()) return

  installStyle()

  let bar = document.getElementById(BAR_ID)
  if (!bar) {
    bar = document.createElement('div')
    bar.id = BAR_ID
    bar.innerHTML = '<input type="search" autocomplete="off" spellcheck="false" placeholder="Search library…" aria-label="Search library">'
    body.prepend(bar)
    bar.querySelector('input').addEventListener('input', event => {
      filterRows(event.target.value)
    })
  }

  const input = bar.querySelector('input')
  if (input && document.activeElement !== input) {
    // React may replace the library rows after navigation; reapply the query.
    filterRows(input.value)
  }
}

const observer = new MutationObserver(() => {
  if (isLibraryScreen()) ensureBar()
  else document.getElementById(BAR_ID)?.remove()
})

window.addEventListener('DOMContentLoaded', () => {
  ensureBar()
  const root = document.getElementById('root')
  if (root) observer.observe(root, {subtree: true, childList: true})
})
