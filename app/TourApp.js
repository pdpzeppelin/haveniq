'use client'

import { useState, useEffect, useRef } from 'react'

// ── Constants ──────────────────────────────────────────────────────────────────

const STANDARD_ROOMS = [
  'Kitchen', 'Living room', 'Primary bedroom', 'Bedrooms',
  'Bathrooms', 'Backyard', 'Garage', 'Curb appeal',
]

const REACTIONS = [
  { id: 'love', label: 'Love it',      emoji: '❤️', dot: 'bg-emerald-500', tile: 'bg-emerald-50 border-emerald-300', text: 'text-emerald-600' },
  { id: 'okay', label: "It's okay",    emoji: '👍', dot: 'bg-amber-400',   tile: 'bg-amber-50 border-amber-300',   text: 'text-amber-600'  },
  { id: 'no',   label: 'Not for me',   emoji: '👎', dot: 'bg-red-500',     tile: 'bg-red-50 border-red-300',       text: 'text-red-600'    },
]

// ── Date helpers ───────────────────────────────────────────────────────────────

function tsToDateStr(ts) {
  const d = new Date(ts)
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, day] = dateStr.split('-').map(Number)
  return `${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[m - 1]} ${day}, ${y}`
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function loadHomes() {
  try {
    const raw = localStorage.getItem('haveniq_homes')
    if (!raw) return []
    return JSON.parse(raw).map(h => ({
      ...h,
      dateSeen: h.dateSeen || tsToDateStr(h.createdAt),
      hidden:   h.hidden   ?? false,
      // Migrate old single-photo field to photos array
      rooms: Object.fromEntries(
        Object.entries(h.rooms || {}).map(([name, r]) => {
          const { photo, ...rest } = r
          return [name, { ...rest, photos: r.photos ?? (photo ? [photo] : []) }]
        })
      ),
    }))
  } catch {
    return []
  }
}

function persist(homes) {
  localStorage.setItem('haveniq_homes', JSON.stringify(homes))
}

function makeHome({ address, price, beds, baths, sqft, listingUrl }) {
  const rooms = {}
  STANDARD_ROOMS.forEach(name => {
    rooms[name] = { reaction: null, photos: [], voiceNote: '', textNote: '' }
  })
  const now = Date.now()
  return {
    id: uid(),
    address,
    price:      price      || '',
    beds:       beds       || '',
    baths:      baths      || '',
    sqft:       sqft       || '',
    listingUrl: listingUrl || '',
    dateSeen:   tsToDateStr(now),
    hidden:     false,
    createdAt:  now,
    rooms,
    overall: { likes: '', dislikes: '', feeling: '', closing: '' },
  }
}

// Quick stats across all rooms for a home
function homeStats(home) {
  const entries = Object.entries(home.rooms)
  const loved  = entries.filter(([, r]) => r.reaction === 'love').length
  const okay   = entries.filter(([, r]) => r.reaction === 'okay').length
  const no     = entries.filter(([, r]) => r.reaction === 'no'  ).length
  const photos = entries.filter(([, r]) => r.photos?.length > 0  ).length
  return { loved, okay, no, photos, total: entries.length, rated: loved + okay + no }
}

// Resize via canvas before storing — keeps localStorage light
function resizeImage(dataUrl, maxW = 1200, maxH = 900) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const ratio = Math.min(maxW / img.width, maxH / img.height, 1)
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(img.width  * ratio)
      canvas.height = Math.round(img.height * ratio)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.src = dataUrl
  })
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TourApp() {
  const [homes,          setHomes         ] = useState([])
  const [view,           setView          ] = useState('list')
  const [homeId,         setHomeId        ] = useState(null)
  const [roomName,       setRoomName      ] = useState(null)
  const [form,           setForm          ] = useState({ address: '', price: '', beds: '', baths: '', sqft: '', listingUrl: '' })
  const [newRoomName,    setNewRoomName   ] = useState('')
  const [recording,      setRecording     ] = useState(false)
  const [lightbox,       setLightbox      ] = useState(null)
  const [compareIds,     setCompareIds    ] = useState([])
  const [editingDate,    setEditingDate   ] = useState(false)
  const [reviewOrigin,   setReviewOrigin  ] = useState('grid')
  const [roomOrigin,     setRoomOrigin    ] = useState('grid')
  const [speechSupported, setSpeechSupported] = useState(false)
  const recRef = useRef(null)

  useEffect(() => { setHomes(loadHomes()) }, [])

  // Detect SpeechRecognition once on mount — Safari/iPhone doesn't support it
  useEffect(() => {
    setSpeechSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition))
  }, [])

  function setAndSave(updater) {
    setHomes(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      persist(next)
      return next
    })
  }

  const home = homes.find(h => h.id === homeId)

  function goHome() { setView('list') }
  function goGrid() { setEditingDate(false); setView('grid') }
  function goHub()  { setView('review-hub') }

  const VIEW_NEEDS_HOME = ['grid', 'add-room', 'room', 'overall', 'review']
  if (VIEW_NEEDS_HOME.includes(view) && !home && homes.length > 0) {
    return (
      <Screen>
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-4">
          <p className="text-slate-500 text-sm">Couldn't find that home.</p>
          <button
            onClick={() => { setView('list'); setHomeId(null); setRoomName(null) }}
            className="btn-primary">
            Back to home list
          </button>
        </div>
      </Screen>
    )
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  function submitAddHome(e) {
    e.preventDefault()
    if (!form.address.trim()) return
    const h = makeHome(form)
    setAndSave(prev => [...prev, h])
    setForm({ address: '', price: '', beds: '', baths: '', sqft: '', listingUrl: '' })
    setHomeId(h.id)
    setView('grid')
  }

  function patchRoom(hid, rname, patch) {
    setAndSave(prev => prev.map(h =>
      h.id !== hid ? h : { ...h, rooms: { ...h.rooms, [rname]: { ...h.rooms[rname], ...patch } } }
    ))
  }

  function patchOverall(hid, patch) {
    setAndSave(prev => prev.map(h =>
      h.id !== hid ? h : { ...h, overall: { ...h.overall, ...patch } }
    ))
  }

  function addRoom(hid, name) {
    if (!name.trim()) return
    setAndSave(prev => prev.map(h => {
      if (h.id !== hid || h.rooms[name]) return h
      return { ...h, rooms: { ...h.rooms, [name]: { reaction: null, photos: [], voiceNote: '', textNote: '' } } }
    }))
  }

  function toggleHidden(hid) {
    setAndSave(prev => prev.map(h => h.id !== hid ? h : { ...h, hidden: !h.hidden }))
    setCompareIds(prev => prev.filter(id => id !== hid))
  }

  function updateDateSeen(hid, dateStr) {
    if (!dateStr) return
    setAndSave(prev => prev.map(h => h.id !== hid ? h : { ...h, dateSeen: dateStr }))
  }

  function toggleCompare(id) {
    setCompareIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // ── Photos ─────────────────────────────────────────────────────────────────

  // Handles one or more files; appends each resized photo to the room's photos array
  function handlePhoto(e, hid, rname) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = async ev => {
        const resized = await resizeImage(ev.target.result)
        setAndSave(prev => prev.map(h =>
          h.id !== hid ? h : {
            ...h,
            rooms: {
              ...h.rooms,
              [rname]: { ...h.rooms[rname], photos: [...(h.rooms[rname].photos || []), resized] },
            },
          }
        ))
      }
      reader.readAsDataURL(file)
    })
    // Reset input so the same file can be re-added if needed
    e.target.value = ''
  }

  function removePhoto(hid, rname, idx) {
    setAndSave(prev => prev.map(h =>
      h.id !== hid ? h : {
        ...h,
        rooms: {
          ...h.rooms,
          [rname]: { ...h.rooms[rname], photos: h.rooms[rname].photos.filter((_, i) => i !== idx) },
        },
      }
    ))
  }

  // ── Voice note ─────────────────────────────────────────────────────────────

  function startRecording(hid, rname) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const sr = new SR()
    sr.continuous = false
    sr.interimResults = false
    sr.lang = 'en-US'
    sr.onresult = ev => {
      const t = ev.results[0][0].transcript
      setHomes(prev => {
        const existing = prev.find(h => h.id === hid)?.rooms[rname]?.voiceNote || ''
        const next = prev.map(h =>
          h.id !== hid ? h : { ...h, rooms: { ...h.rooms, [rname]: { ...h.rooms[rname], voiceNote: existing ? existing + ' ' + t : t } } }
        )
        persist(next)
        return next
      })
      setRecording(false)
    }
    sr.onerror = () => setRecording(false)
    sr.onend   = () => setRecording(false)
    recRef.current = sr
    sr.start()
    setRecording(true)
  }

  function stopRecording() { recRef.current?.stop(); setRecording(false) }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEWS
  // ════════════════════════════════════════════════════════════════════════════

  // ── Add home ───────────────────────────────────────────────────────────────
  if (view === 'add-home') {
    return (
      <Screen>
        <Header back={goHome} title="Add a home" />
        <form onSubmit={submitAddHome} className="flex flex-col gap-4 p-4 flex-1">
          <Field label="Address *">
            <input required placeholder="123 Maple St, Austin TX"
              value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
              className="input" />
          </Field>
          <Field label="Listing URL (optional)">
            <input type="url" placeholder="https://zillow.com/homedetails/…"
              value={form.listingUrl} onChange={e => setForm(p => ({ ...p, listingUrl: e.target.value }))}
              className="input" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price ($)">
              <input type="number" placeholder="450000" value={form.price}
                onChange={e => setForm(p => ({ ...p, price: e.target.value }))} className="input" />
            </Field>
            <Field label="Sq ft">
              <input type="number" placeholder="1800" value={form.sqft}
                onChange={e => setForm(p => ({ ...p, sqft: e.target.value }))} className="input" />
            </Field>
            <Field label="Beds">
              <input type="number" placeholder="3" value={form.beds}
                onChange={e => setForm(p => ({ ...p, beds: e.target.value }))} className="input" />
            </Field>
            <Field label="Baths">
              <input type="number" placeholder="2" value={form.baths}
                onChange={e => setForm(p => ({ ...p, baths: e.target.value }))} className="input" />
            </Field>
          </div>
          <button type="submit" className="btn-primary mt-auto">Start Tour →</button>
        </form>
      </Screen>
    )
  }

  // ── Room grid ──────────────────────────────────────────────────────────────
  if (view === 'grid' && home) {
    const entries = Object.entries(home.rooms)
    const rated = entries.filter(([, r]) => r.reaction).length

    return (
      <Screen>
        <header className="bg-navy px-4 py-3">
          <div className="flex items-center gap-2">
            <BackBtn onClick={goHome} />
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm truncate">{home.address}</p>
              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                <span className="text-teal-300 text-xs">{rated}/{entries.length} rooms</span>
                {editingDate ? (
                  <input
                    type="date"
                    defaultValue={home.dateSeen}
                    autoFocus
                    onChange={e => updateDateSeen(home.id, e.target.value)}
                    onBlur={() => setEditingDate(false)}
                    className="text-xs bg-transparent text-white border-b border-teal-400 focus:outline-none"
                    style={{ colorScheme: 'dark' }}
                  />
                ) : (
                  <button onClick={() => setEditingDate(true)}
                    className="flex items-center gap-1 text-xs text-teal-200">
                    <span>📅 {formatDate(home.dateSeen)}</span>
                    <span className="underline underline-offset-1 text-teal-400">edit</span>
                  </button>
                )}
              </div>
              {home.listingUrl && (
                <a href={home.listingUrl} target="_blank" rel="noopener noreferrer"
                  className="text-teal-200 text-xs underline underline-offset-2 mt-0.5 block">
                  View listing ↗
                </a>
              )}
            </div>
            <button
              onClick={() => { setReviewOrigin('grid'); setView('review') }}
              className="bg-teal-500 text-white text-sm font-semibold px-3 py-1.5 rounded-lg shrink-0">
              Review
            </button>
          </div>
        </header>

        <div className="p-3 grid grid-cols-2 gap-2">
          {entries.map(([rname, rdata]) => {
            const rx = REACTIONS.find(r => r.id === rdata.reaction)
            return (
              <button key={rname}
                onClick={() => { setRoomName(rname); setRoomOrigin('grid'); setView('room') }}
                className={`relative flex flex-col items-start justify-end p-3 rounded-2xl border-2 text-left
                  ${rx ? rx.tile : 'bg-white border-slate-200'}`}>
                {rx && <span className={`absolute top-2.5 right-2.5 w-2.5 h-2.5 rounded-full ${rx.dot}`} />}
                <span className="font-semibold text-slate-800 text-sm leading-tight pr-4">{rname}</span>
                {rx
                  ? <span className={`text-xs mt-0.5 font-medium ${rx.text}`}>{rx.label}</span>
                  : <span className="text-xs mt-0.5 text-slate-400">Tap to rate</span>}
                {(rdata.photos?.length > 0 || rdata.voiceNote || rdata.textNote) && (
                  <div className="flex gap-1 mt-1">
                    {rdata.photos?.length > 0 && <span className="text-xs">📷</span>}
                    {(rdata.voiceNote || rdata.textNote) && <span className="text-xs">📝</span>}
                  </div>
                )}
              </button>
            )
          })}

          <button onClick={() => setView('overall')}
            className="flex flex-col items-start justify-end p-3 rounded-2xl border-2 bg-navy border-navy text-left">
            <span className="font-semibold text-white text-sm leading-tight">Overall notes & feeling</span>
            <span className="text-xs mt-0.5 text-teal-300">
              {Object.values(home.overall).some(Boolean) ? 'Notes added ✓' : 'Tap to add'}
            </span>
          </button>

          <button onClick={() => setView('add-room')}
            className="flex flex-col items-center justify-center p-3 rounded-2xl border-2 border-dashed border-slate-300 bg-white">
            <span className="text-2xl text-slate-400 leading-none">+</span>
            <span className="text-xs text-slate-500 mt-0.5 font-medium">Add room</span>
          </button>
        </div>
      </Screen>
    )
  }

  // ── Add room ───────────────────────────────────────────────────────────────
  if (view === 'add-room' && home) {
    return (
      <Screen>
        <Header back={goGrid} title="Add a room" />
        <div className="p-4 flex flex-col gap-4">
          <input autoFocus placeholder="e.g. Office, Basement, Laundry room…"
            value={newRoomName} onChange={e => setNewRoomName(e.target.value)}
            className="input" />
          <button onClick={() => {
            const name = newRoomName.trim()
            if (!name) return
            addRoom(home.id, name)
            setNewRoomName('')
            setRoomName(name)
            setRoomOrigin('grid')
            setView('room')
          }} className="btn-primary">Add Room</button>
        </div>
      </Screen>
    )
  }

  // ── Room detail ────────────────────────────────────────────────────────────
  if (view === 'room' && home && roomName) {
    const rdata = home.rooms[roomName]
    const photos = rdata.photos || []
    return (
      <Screen>
        {lightbox && (
          <div className="fixed inset-0 z-50 bg-black/92 flex items-center justify-center p-4"
            onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="Room photo"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '12px' }} />
            <button onClick={() => setLightbox(null)}
              className="absolute top-5 right-5 bg-white/20 text-white rounded-full w-10 h-10 flex items-center justify-center text-xl font-bold">
              ✕
            </button>
            <p className="absolute bottom-6 text-white/50 text-xs">Tap anywhere to close</p>
          </div>
        )}

        <Header back={roomOrigin === 'review' ? () => setView('review') : goGrid} title={roomName} />
        <div className="p-4 flex flex-col gap-6 pb-6">

          {/* Reaction */}
          <div>
            <SectionLabel>How do you feel about this room?</SectionLabel>
            <div className="flex flex-col gap-3 mt-2">
              {REACTIONS.map(rx => {
                const active = rdata.reaction === rx.id
                return (
                  <button key={rx.id}
                    onClick={() => patchRoom(home.id, roomName, { reaction: active ? null : rx.id })}
                    className={`flex items-center gap-4 p-4 rounded-2xl border-2 text-left transition-all
                      ${active ? rx.tile : 'bg-white border-slate-200'}`}>
                    <span className="text-2xl">{rx.emoji}</span>
                    <span className={`font-semibold text-base ${active ? rx.text : 'text-slate-700'}`}>{rx.label}</span>
                    {active && (
                      <span className={`ml-auto w-6 h-6 rounded-full ${rx.dot} flex items-center justify-center shrink-0`}>
                        <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Photos — multiple, library or camera, thumbnail grid */}
          <div>
            <SectionLabel>Photos</SectionLabel>
            {photos.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {photos.map((photo, idx) => (
                  <div key={idx} className="relative">
                    <button onClick={() => setLightbox(photo)}
                      className="block w-full rounded-xl overflow-hidden">
                      <img src={photo} alt={`Room photo ${idx + 1}`}
                        className="w-full rounded-xl"
                        style={{ height: '90px', objectFit: 'cover', display: 'block' }} />
                    </button>
                    <button onClick={() => removePhoto(home.id, roomName, idx)}
                      className="absolute top-1 left-1 bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold leading-none">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* No capture attribute → lets user choose camera or photo library */}
            <label className="mt-2 flex items-center gap-3 bg-white border-2 border-dashed border-slate-300 rounded-xl p-4 cursor-pointer active:bg-slate-50">
              <span className="text-2xl">📷</span>
              <span className="text-slate-600 font-medium">
                {photos.length > 0 ? 'Add another photo' : 'Take or add a photo'}
              </span>
              <input type="file" accept="image/*" multiple className="sr-only"
                onChange={e => handlePhoto(e, home.id, roomName)} />
            </label>
          </div>

          {/* Voice note — shown only if browser supports SpeechRecognition */}
          <div>
            <SectionLabel>Voice note</SectionLabel>
            {speechSupported ? (
              <>
                <button onClick={recording ? stopRecording : () => startRecording(home.id, roomName)}
                  className={`mt-2 flex items-center gap-3 w-full p-4 rounded-xl border-2 transition-all
                    ${recording ? 'bg-red-50 border-red-400' : 'bg-white border-slate-300'}`}>
                  <span className="text-2xl">{recording ? '⏹' : '🎤'}</span>
                  <span className={`font-medium ${recording ? 'text-red-600 animate-pulse' : 'text-slate-600'}`}>
                    {recording ? 'Recording… tap to stop' : 'Tap to record'}
                  </span>
                </button>
                {rdata.voiceNote && (
                  <div className="mt-2 bg-slate-100 rounded-xl p-3 text-sm text-slate-700 relative pr-12">
                    <p>{rdata.voiceNote}</p>
                    <button onClick={() => patchRoom(home.id, roomName, { voiceNote: '' })}
                      className="absolute top-2 right-3 text-slate-400 text-xs">Clear</button>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-2 bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-start gap-3">
                <span className="text-xl shrink-0">⌨️</span>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Tap the <strong>Notes</strong> field below, then tap the{' '}
                  <strong>microphone on your keyboard</strong> to dictate. Your words will save automatically.
                </p>
              </div>
            )}
          </div>

          {/* Notes — standard textarea; iPhone keyboard dictation works naturally here */}
          <div>
            <SectionLabel>Notes</SectionLabel>
            <textarea rows={3} placeholder="Anything else about this room…"
              value={rdata.textNote}
              onChange={e => patchRoom(home.id, roomName, { textNote: e.target.value })}
              className="mt-2 w-full border border-slate-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none bg-white" />
          </div>

          <button
            onClick={roomOrigin === 'review' ? () => setView('review') : goGrid}
            className="btn-primary">
            Done — back to {roomOrigin === 'review' ? 'review' : 'rooms'}
          </button>
        </div>
      </Screen>
    )
  }

  // ── Overall notes ──────────────────────────────────────────────────────────
  if (view === 'overall' && home) {
    const fields = [
      { key: 'likes',    label: 'What did you love about this home?', placeholder: 'Big windows, quiet street, great layout…' },
      { key: 'dislikes', label: "What didn't work for you?",          placeholder: 'Small master bath, busy road, no storage…' },
      { key: 'feeling',  label: 'Overall feeling',                    placeholder: 'Excited? Unsure? Could see us living here?' },
      { key: 'closing',  label: 'Closing notes',                      placeholder: 'Anything else to remember…' },
    ]
    return (
      <Screen>
        <Header back={goGrid} title="Overall notes & feeling" />
        <div className="p-4 flex flex-col gap-5 pb-6">
          {fields.map(f => (
            <div key={f.key}>
              <SectionLabel>{f.label}</SectionLabel>
              <textarea rows={3} placeholder={f.placeholder}
                value={home.overall[f.key]}
                onChange={e => patchOverall(home.id, { [f.key]: e.target.value })}
                className="mt-2 w-full border border-slate-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none bg-white" />
            </div>
          ))}
          <button onClick={goGrid} className="btn-primary">Done — back to rooms</button>
        </div>
      </Screen>
    )
  }

  // ── Per-home review ────────────────────────────────────────────────────────
  if (view === 'review' && home) {
    const entries = Object.entries(home.rooms)
    const { loved, okay, no, photos, total, rated: ratedCount } = homeStats(home)
    const ratedRooms   = entries.filter(([, r]) => r.reaction)
    const unratedRooms = entries.filter(([, r]) => !r.reaction)
    const hasOverall   = Object.values(home.overall).some(Boolean)
    const backFn       = reviewOrigin === 'hub' ? goHub : goGrid
    const backLabel    = reviewOrigin === 'hub' ? '← Back to review hub' : '← Back to room grid'

    return (
      <Screen>
        <header className="bg-navy px-4 py-4">
          <div className="flex items-center gap-3">
            <BackBtn onClick={backFn} />
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-base">My Review</p>
              <p className="text-teal-300 text-xs truncate">{home.address}</p>
            </div>
          </div>
        </header>

        <div className="p-4 flex flex-col gap-4 pb-8">

          {/* Home meta card */}
          <div className="bg-white rounded-2xl p-4 border border-slate-100">
            <p className="font-semibold text-slate-800 text-base leading-snug">{home.address}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-0 mt-1 text-xs text-slate-500">
              {home.price && <span>${Number(home.price).toLocaleString()}</span>}
              {home.beds  && <span>{home.beds} bed</span>}
              {home.baths && <span>{home.baths} bath</span>}
              {home.sqft  && <span>{Number(home.sqft).toLocaleString()} sqft</span>}
            </div>
            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
              <span className="text-xs text-slate-500">📅 Toured {formatDate(home.dateSeen)}</span>
              {home.listingUrl && (
                <a href={home.listingUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs font-semibold text-teal-600 underline underline-offset-2">
                  View listing ↗
                </a>
              )}
            </div>
          </div>

          {/* Overall feeling callout */}
          {home.overall.feeling && (
            <div className="bg-teal-50 border border-teal-200 rounded-2xl p-4">
              <p className="text-xs font-semibold text-teal-600 uppercase tracking-wide mb-1">Overall feeling</p>
              <p className="text-slate-800 text-sm italic leading-relaxed">"{home.overall.feeling}"</p>
            </div>
          )}

          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Loved', count: loved, bg: 'bg-emerald-500' },
              { label: 'Okay',  count: okay,  bg: 'bg-amber-400'   },
              { label: 'No',    count: no,    bg: 'bg-red-500'     },
            ].map(s => (
              <div key={s.label} className="bg-white rounded-2xl p-3 text-center border border-slate-100">
                <div className={`w-10 h-10 ${s.bg} rounded-full mx-auto flex items-center justify-center`}>
                  <span className="text-white font-bold text-lg">{s.count}</span>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Summary pills */}
          <div className="flex gap-2 flex-wrap">
            <span className="bg-slate-100 text-slate-600 text-xs px-3 py-1 rounded-full">
              {ratedCount}/{total} rooms rated
            </span>
            {photos > 0 && (
              <span className="bg-slate-100 text-slate-600 text-xs px-3 py-1 rounded-full">
                📷 {photos} room{photos !== 1 ? 's' : ''} with photos
              </span>
            )}
          </div>

          {/* Rated rooms */}
          {ratedRooms.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Rooms</p>
              <div className="flex flex-col gap-2">
                {ratedRooms.map(([rname, rdata]) => {
                  const rx = REACTIONS.find(r => r.id === rdata.reaction)
                  return (
                    <button key={rname}
                      onClick={() => { setRoomName(rname); setRoomOrigin('review'); setView('room') }}
                      className="bg-white rounded-2xl p-4 border border-slate-100 text-left flex items-start gap-3">
                      <span className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${rx.dot}`} />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-800 text-sm">{rname}</p>
                        <p className={`text-xs ${rx.text}`}>{rx.label}</p>
                        {(rdata.textNote || rdata.voiceNote) && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                            {rdata.textNote || rdata.voiceNote}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0 mt-0.5">
                        {rdata.photos?.length > 0 && <span className="text-xs">📷</span>}
                        {rdata.voiceNote         && <span className="text-xs">🎤</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Unrated rooms */}
          {unratedRooms.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Not yet rated</p>
              <div className="flex flex-wrap gap-2">
                {unratedRooms.map(([rname]) => (
                  <button key={rname}
                    onClick={() => { setRoomName(rname); setRoomOrigin('review'); setView('room') }}
                    className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs text-slate-500 font-medium">
                    {rname}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Overall notes */}
          {hasOverall && (
            <div className="bg-navy rounded-2xl p-4">
              <p className="text-teal-300 font-semibold text-sm mb-3">Overall notes</p>
              {[
                { key: 'likes',    label: '❤️ Loved'      },
                { key: 'dislikes', label: '✕ Didn\'t work' },
                { key: 'feeling',  label: '💭 Feeling'     },
                { key: 'closing',  label: '📌 Closing'     },
              ].filter(f => home.overall[f.key]).map(f => (
                <div key={f.key} className="mb-3 last:mb-0">
                  <p className="text-xs text-slate-400">{f.label}</p>
                  <p className="text-white text-sm mt-0.5">{home.overall[f.key]}</p>
                </div>
              ))}
            </div>
          )}

          <button onClick={backFn} className="btn-secondary">{backLabel}</button>
        </div>
      </Screen>
    )
  }

  // ── Review hub ─────────────────────────────────────────────────────────────
  if (view === 'review-hub') {
    const byDate = (a, b) => (b.dateSeen > a.dateSeen ? 1 : b.dateSeen < a.dateSeen ? -1 : 0)
    const active = homes.filter(h => !h.hidden).sort(byDate)
    const hidden = homes.filter(h =>  h.hidden).sort(byDate)
    const canCompare = compareIds.length >= 2

    return (
      <Screen>
        <Header back={goHome} title="Review & Compare" />

        <div className="p-4 flex flex-col gap-3 pb-28">

          {active.length === 0 && (
            <div className="text-center py-12">
              <p className="text-slate-400 text-sm">No active homes. Add some homes to start reviewing.</p>
            </div>
          )}

          {active.map(h => {
            const { loved, okay, no, photos } = homeStats(h)
            const selected = compareIds.includes(h.id)
            return (
              <div key={h.id}
                className={`bg-white rounded-2xl border-2 overflow-hidden transition-all
                  ${selected ? 'border-teal-500 shadow-md' : 'border-slate-200'}`}>

                <div className="px-4 pt-3 flex items-center justify-between gap-2">
                  <button onClick={() => toggleCompare(h.id)}
                    className="flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all
                      ${selected ? 'bg-teal-500 border-teal-500' : 'border-slate-300 bg-white'}`}>
                      {selected && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span className="text-xs text-slate-500 font-medium">
                      {selected ? 'Selected for compare' : 'Add to compare'}
                    </span>
                  </button>
                  <button
                    onClick={() => { setHomeId(h.id); setReviewOrigin('hub'); setView('review') }}
                    className="text-xs text-teal-600 font-semibold">
                    Full review →
                  </button>
                </div>

                <button onClick={() => { setHomeId(h.id); setView('grid') }}
                  className="w-full text-left px-4 py-3">
                  <p className="font-semibold text-slate-800 text-sm leading-snug">{h.address}</p>
                  <div className="flex flex-wrap gap-x-2 mt-0.5 text-xs text-slate-500">
                    {h.price && <span>${Number(h.price).toLocaleString()}</span>}
                    {h.beds  && <span>{h.beds}bd</span>}
                    {h.baths && <span>{h.baths}ba</span>}
                    {h.sqft  && <span>{Number(h.sqft).toLocaleString()} sqft</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                    <span className="text-xs text-slate-500">📅 {formatDate(h.dateSeen)}</span>
                    {h.listingUrl && <span className="text-xs text-teal-500 font-medium">🔗 Listing</span>}
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="bg-emerald-100 text-emerald-700 text-xs font-medium px-2 py-0.5 rounded-full">❤️ {loved}</span>
                    <span className="bg-amber-100  text-amber-700  text-xs font-medium px-2 py-0.5 rounded-full">👍 {okay}</span>
                    <span className="bg-red-100    text-red-700    text-xs font-medium px-2 py-0.5 rounded-full">👎 {no}</span>
                    {photos > 0 && (
                      <span className="bg-slate-100 text-slate-600 text-xs font-medium px-2 py-0.5 rounded-full">📷 {photos}</span>
                    )}
                  </div>
                  {h.overall.feeling && (
                    <p className="text-xs text-slate-500 italic mt-2 line-clamp-1">"{h.overall.feeling}"</p>
                  )}
                </button>

                <div className="px-4 pb-3 border-t border-slate-100 pt-2">
                  <button onClick={() => toggleHidden(h.id)}
                    className="text-xs text-slate-400 underline underline-offset-2">
                    Out of the running ↓
                  </button>
                </div>
              </div>
            )
          })}

          {hidden.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
                Out of the running
              </p>
              <div className="flex flex-col gap-3">
                {hidden.map(h => {
                  const { loved, okay, no } = homeStats(h)
                  return (
                    <div key={h.id}
                      className="bg-white rounded-2xl border border-slate-200 p-4 opacity-50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-700 text-sm leading-snug line-clamp-1">{h.address}</p>
                          <p className="text-xs text-slate-400 mt-0.5">📅 {formatDate(h.dateSeen)}</p>
                          <div className="flex gap-2 mt-1.5">
                            <span className="text-xs text-slate-500">❤️ {loved}</span>
                            <span className="text-xs text-slate-500">👍 {okay}</span>
                            <span className="text-xs text-slate-500">👎 {no}</span>
                          </div>
                        </div>
                        <button onClick={() => toggleHidden(h.id)}
                          className="shrink-0 text-xs text-teal-600 font-semibold border border-teal-200 rounded-lg px-2.5 py-1">
                          Restore ↑
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {canCompare && (
          <div className="fixed bottom-0 left-0 right-0 flex justify-center pointer-events-none" style={{ zIndex: 40 }}>
            <div className="w-full max-w-[480px] pointer-events-auto bg-white border-t border-slate-200 px-4 py-3">
              <button onClick={() => setView('compare')}
                className="w-full bg-navy text-white rounded-2xl py-3.5 font-semibold text-base shadow-lg">
                Compare {compareIds.length} homes side by side →
              </button>
            </div>
          </div>
        )}
      </Screen>
    )
  }

  // ── Compare ────────────────────────────────────────────────────────────────
  if (view === 'compare') {
    return (
      <CompareView
        compareHomes={homes.filter(h => compareIds.includes(h.id))}
        onBack={goHub}
      />
    )
  }

  // ── Home list ──────────────────────────────────────────────────────────────
  {
    const activeHomes = homes.filter(h => !h.hidden)
    const hiddenHomes = homes.filter(h =>  h.hidden)

    const HomeCard = ({ h }) => {
      const entries    = Object.entries(h.rooms)
      const ratedCount = entries.filter(([, r]) => r.reaction).length
      const lovedN     = entries.filter(([, r]) => r.reaction === 'love').length
      const okayN      = entries.filter(([, r]) => r.reaction === 'okay').length
      const noN        = entries.filter(([, r]) => r.reaction === 'no'  ).length
      return (
        <button
          onClick={() => { setHomeId(h.id); setView('grid') }}
          className="bg-white rounded-2xl p-4 border border-slate-200 text-left w-full shadow-sm">
          <p className="font-semibold text-slate-800 text-base leading-tight">{h.address}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-0 mt-1 text-xs text-slate-500">
            {h.price && <span>${Number(h.price).toLocaleString()}</span>}
            {h.beds  && <span>{h.beds} bed</span>}
            {h.baths && <span>{h.baths} bath</span>}
            {h.sqft  && <span>{Number(h.sqft).toLocaleString()} sqft</span>}
          </div>
          {ratedCount > 0 ? (
            <div className="flex flex-wrap gap-2 mt-3">
              {lovedN > 0 && <span className="bg-emerald-100 text-emerald-700 text-xs font-medium px-2 py-0.5 rounded-full">❤️ {lovedN}</span>}
              {okayN  > 0 && <span className="bg-amber-100  text-amber-700  text-xs font-medium px-2 py-0.5 rounded-full">👍 {okayN}</span>}
              {noN    > 0 && <span className="bg-red-100    text-red-700    text-xs font-medium px-2 py-0.5 rounded-full">👎 {noN}</span>}
              <span className="text-slate-400 text-xs self-center">{ratedCount}/{entries.length} rooms</span>
            </div>
          ) : (
            <p className="text-xs text-slate-400 mt-2">Tour not started</p>
          )}
        </button>
      )
    }

    return (
      <Screen>
        <header className="bg-navy px-4 pt-12 pb-6">
          <h1 className="text-white text-2xl font-bold tracking-tight">HavenIQ</h1>
          <p className="text-teal-300 text-sm mt-0.5">Your home tour journal</p>
        </header>

        <main className="flex-1 p-4 flex flex-col gap-3">
          {homes.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <div className="text-5xl mb-4">🏡</div>
              <h2 className="text-slate-700 font-semibold text-lg mb-2">No homes yet</h2>
              <p className="text-slate-500 text-sm max-w-xs leading-relaxed">
                Add your first home below to start capturing room-by-room reactions during your tour.
              </p>
            </div>
          )}

          {activeHomes.map(h => <HomeCard key={h.id} h={h} />)}

          {hiddenHomes.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
                Out of the running
              </p>
              <div className="flex flex-col gap-2">
                {hiddenHomes.map(h => {
                  const { loved, okay, no } = homeStats(h)
                  return (
                    <div key={h.id} className="bg-white rounded-2xl border border-slate-200 p-4 opacity-50">
                      <div className="flex items-start justify-between gap-3">
                        <button
                          onClick={() => { setHomeId(h.id); setView('grid') }}
                          className="flex-1 min-w-0 text-left">
                          <p className="font-semibold text-slate-700 text-sm leading-snug line-clamp-1">{h.address}</p>
                          <p className="text-xs text-slate-400 mt-0.5">📅 {formatDate(h.dateSeen)}</p>
                          <div className="flex gap-2 mt-1.5">
                            <span className="text-xs text-slate-500">❤️ {loved}</span>
                            <span className="text-xs text-slate-500">👍 {okay}</span>
                            <span className="text-xs text-slate-500">👎 {no}</span>
                          </div>
                        </button>
                        <button
                          onClick={() => toggleHidden(h.id)}
                          className="shrink-0 text-xs text-teal-600 font-semibold border border-teal-200 rounded-lg px-2.5 py-1">
                          Restore ↑
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </main>

        <div className="sticky bottom-0 p-4 bg-slate-50 border-t border-slate-200 flex flex-col gap-2">
          <button onClick={() => setView('add-home')} className="btn-primary">+ Add a home</button>
          {homes.length > 0 && (
            <button onClick={() => setView('review-hub')} className="btn-secondary">Review & Compare →</button>
          )}
        </div>
      </Screen>
    )
  }
}

// ── Shared UI pieces ───────────────────────────────────────────────────────────

function Screen({ children }) {
  return (
    <div className="min-h-screen bg-slate-200">
      <div className="mx-auto w-full bg-slate-50 flex flex-col min-h-screen" style={{ maxWidth: '480px' }}>
        {children}
      </div>
    </div>
  )
}

function Header({ back, title }) {
  return (
    <header className="bg-navy px-4 py-4 flex items-center gap-3">
      <BackBtn onClick={back} />
      <h1 className="text-white font-semibold text-lg">{title}</h1>
    </header>
  )
}

function BackBtn({ onClick }) {
  return (
    <button onClick={onClick}
      className="text-white text-2xl leading-none w-8 h-8 flex items-center justify-center shrink-0">
      ←
    </button>
  )
}

function SectionLabel({ children }) {
  return <p className="text-sm font-medium text-slate-600">{children}</p>
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      {children}
    </div>
  )
}

// ── Compare view ───────────────────────────────────────────────────────────────

const COMPARE_PALETTE = [
  { bg: 'bg-teal-500',   border: 'border-teal-300',   light: 'bg-teal-50',   text: 'text-teal-700',   chip: 'bg-teal-500'   },
  { bg: 'bg-violet-500', border: 'border-violet-300', light: 'bg-violet-50', text: 'text-violet-700', chip: 'bg-violet-500' },
  { bg: 'bg-amber-500',  border: 'border-amber-300',  light: 'bg-amber-50',  text: 'text-amber-700',  chip: 'bg-amber-500'  },
  { bg: 'bg-rose-500',   border: 'border-rose-300',   light: 'bg-rose-50',   text: 'text-rose-700',   chip: 'bg-rose-500'   },
]

function shortLabel(address) {
  const street = address.split(',')[0].trim()
  const words  = street.split(/\s+/)
  return words.length >= 2 ? `${words[0]} ${words[1]}` : street.slice(0, 16)
}

function CompareView({ compareHomes, onBack }) {
  const [attr,       setAttr      ] = useState('overview')
  const [expandedId, setExpandedId] = useState(null)
  const [lightbox,   setLightbox  ] = useState(null)

  const homes = compareHomes.map((h, i) => ({
    ...h,
    _color: COMPARE_PALETTE[i % COMPARE_PALETTE.length],
    _label: shortLabel(h.address),
  }))

  const allRoomNames = [
    ...new Set([
      ...STANDARD_ROOMS.filter(r => compareHomes.some(h => h.rooms[r])),
      ...compareHomes.flatMap(h => Object.keys(h.rooms).filter(r => !STANDARD_ROOMS.includes(r))),
    ])
  ]

  const ATTRS = [
    { id: 'overview',  label: 'Overview' },
    ...allRoomNames.map(r => ({ id: r, label: r })),
    { id: 'likes',     label: 'Likes'    },
    { id: 'concerns',  label: 'Concerns' },
    { id: 'price',     label: 'Price'    },
    { id: 'date',      label: 'Date seen'},
  ]

  return (
    <div className="min-h-screen bg-slate-200">
      <div className="mx-auto w-full bg-slate-50 flex flex-col min-h-screen"
        style={{ maxWidth: '480px' }}>

        {lightbox && (
          <div className="fixed inset-0 z-50 bg-black/92 flex items-center justify-center p-4"
            onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="Photo"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '12px' }} />
            <button onClick={() => setLightbox(null)}
              className="absolute top-5 right-5 bg-white/20 text-white rounded-full w-10 h-10 flex items-center justify-center text-xl font-bold">
              ✕
            </button>
            <p className="absolute bottom-6 text-white/50 text-xs">Tap anywhere to close</p>
          </div>
        )}

        <div className="sticky top-0 z-10">
          <header className="bg-navy px-4 py-4 flex items-center gap-3">
            <BackBtn onClick={onBack} />
            <h1 className="text-white font-semibold text-lg">
              Comparing {homes.length} homes
            </h1>
          </header>

          <div className="bg-white border-b border-slate-200 px-4 py-2.5 flex flex-col gap-1.5">
            {homes.map(h => {
              const { loved, okay, no } = homeStats(h)
              return (
                <div key={h.id} className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${h._color.bg}`} />
                  <span className={`font-bold text-xs shrink-0 ${h._color.text}`}>{h._label}</span>
                  <span className="text-xs text-slate-400 shrink-0">·</span>
                  <span className="text-xs text-slate-500 shrink-0">❤️{loved} 👍{okay} 👎{no}</span>
                  {h.overall.feeling && (
                    <span className="text-xs text-slate-400 italic truncate min-w-0">
                      "{h.overall.feeling}"
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <div className="bg-white border-b border-slate-200 py-2.5">
            <div className="overflow-x-auto px-4">
              <div className="flex gap-1.5 w-max">
                {ATTRS.map(a => (
                  <button key={a.id}
                    onClick={() => setAttr(a.id)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all
                      ${attr === a.id ? 'bg-navy text-white' : 'bg-slate-100 text-slate-600'}`}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 flex flex-col gap-3 pb-8">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            {ATTRS.find(a => a.id === attr)?.label ?? attr}
          </p>

          {homes.map(h => {
            const isExpanded = expandedId === h.id
            return (
              <div key={h.id}
                className={`rounded-2xl border-2 overflow-hidden bg-white ${h._color.border}`}>
                <div className={`px-4 py-2 flex items-center justify-between ${h._color.light}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${h._color.bg}`} />
                    <span className={`font-bold text-sm ${h._color.text}`}>{h._label}</span>
                    <span className="text-xs text-slate-500 truncate max-w-[160px]">{h.address}</span>
                  </div>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : h.id)}
                    className={`text-xs font-semibold shrink-0 ml-2 ${h._color.text}`}>
                    {isExpanded ? 'Collapse ▲' : 'Expand ▼'}
                  </button>
                </div>

                <div className="px-4 py-3">
                  <CompareAttrContent home={h} attr={attr} onLightbox={setLightbox} />
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-100 px-4 py-3 flex flex-col gap-3 bg-slate-50/50">
                    <CompareExpandedDetail home={h} />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="p-4 border-t border-slate-200 bg-slate-50">
          <button onClick={onBack} className="btn-secondary">← Back to review hub</button>
        </div>
      </div>
    </div>
  )
}

function CompareAttrContent({ home, attr, onLightbox }) {

  if (attr === 'overview') {
    const { loved, okay, no } = homeStats(home)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-5">
          {[
            { label: 'Loved', count: loved, dot: 'bg-emerald-500' },
            { label: 'Okay',  count: okay,  dot: 'bg-amber-400'   },
            { label: 'No',    count: no,    dot: 'bg-red-500'     },
          ].map(s => (
            <div key={s.label} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
              <span className="text-lg font-bold text-slate-800">{s.count}</span>
              <span className="text-xs text-slate-500">{s.label}</span>
            </div>
          ))}
        </div>
        {home.overall.feeling
          ? <p className="text-sm text-slate-700 italic leading-relaxed">"{home.overall.feeling}"</p>
          : <p className="text-xs text-slate-400">No overall feeling noted</p>}
      </div>
    )
  }

  if (attr === 'likes') {
    return home.overall.likes
      ? <p className="text-sm text-slate-700 leading-relaxed">{home.overall.likes}</p>
      : <p className="text-xs text-slate-400">Nothing noted</p>
  }

  if (attr === 'concerns') {
    return home.overall.dislikes
      ? <p className="text-sm text-slate-700 leading-relaxed">{home.overall.dislikes}</p>
      : <p className="text-xs text-slate-400">Nothing noted</p>
  }

  if (attr === 'price') {
    return home.price
      ? <p className="text-2xl font-bold text-slate-800">${Number(home.price).toLocaleString()}</p>
      : <p className="text-xs text-slate-400">No price added</p>
  }

  if (attr === 'date') {
    return <p className="text-sm font-medium text-slate-700">📅 {formatDate(home.dateSeen)}</p>
  }

  const room = home.rooms[attr]
  if (!room) {
    return <p className="text-xs text-slate-400 italic">Room not tracked for this home</p>
  }

  const rx = REACTIONS.find(r => r.id === room.reaction)
  const roomPhotos = room.photos || []
  const hasContent = rx || room.textNote || room.voiceNote || roomPhotos.length > 0

  return (
    <div className="flex flex-col gap-2.5">
      {rx ? (
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${rx.dot}`} />
          <span className={`text-sm font-semibold ${rx.text}`}>{rx.emoji} {rx.label}</span>
        </div>
      ) : (
        <span className="text-xs text-slate-400">Not rated yet</span>
      )}

      {(room.textNote || room.voiceNote) && (
        <p className="text-sm text-slate-700 leading-relaxed">
          {room.textNote || room.voiceNote}
        </p>
      )}

      {roomPhotos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {roomPhotos.map((photo, idx) => (
            <button key={idx} onClick={() => onLightbox(photo)} className="relative block">
              <img src={photo} alt={`${attr} photo ${idx + 1}`}
                className="rounded-xl"
                style={{ width: '72px', height: '72px', objectFit: 'cover', display: 'block' }} />
            </button>
          ))}
        </div>
      )}

      {!hasContent && (
        <p className="text-xs text-slate-400">No notes or photo added</p>
      )}
    </div>
  )
}

function CompareExpandedDetail({ home }) {
  const entries    = Object.entries(home.rooms)
  const ratedRooms = entries.filter(([, r]) => r.reaction)
  const hasOverall = Object.values(home.overall).some(Boolean)

  return (
    <>
      {ratedRooms.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">All rooms</p>
          <div className="flex flex-col gap-1.5">
            {ratedRooms.map(([rname, rdata]) => {
              const rx = REACTIONS.find(r => r.id === rdata.reaction)
              return (
                <div key={rname} className="flex items-start gap-2">
                  <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${rx.dot}`} />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-slate-700">{rname}</span>
                    {(rdata.textNote || rdata.voiceNote) && (
                      <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">
                        {rdata.textNote || rdata.voiceNote}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {rdata.photos?.length > 0 && <span className="text-xs">📷</span>}
                    {rdata.voiceNote          && <span className="text-xs">🎤</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {hasOverall && (
        <div className="bg-white rounded-xl p-3 border border-slate-100 flex flex-col gap-2">
          {[
            { key: 'likes',    label: '❤️ Liked'    },
            { key: 'dislikes', label: '⚠ Concerns'  },
            { key: 'feeling',  label: '💭 Feeling'   },
            { key: 'closing',  label: '📌 Closing'   },
          ].filter(f => home.overall[f.key]).map(f => (
            <div key={f.key}>
              <p className="text-xs text-slate-400 font-medium">{f.label}</p>
              <p className="text-xs text-slate-700 mt-0.5 leading-relaxed">{home.overall[f.key]}</p>
            </div>
          ))}
        </div>
      )}

      {home.listingUrl && (
        <a href={home.listingUrl} target="_blank" rel="noopener noreferrer"
          className="text-xs text-teal-600 font-semibold underline underline-offset-2 self-start">
          View listing ↗
        </a>
      )}
    </>
  )
}
