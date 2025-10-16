let events = [];
let currentIndex = 0;

const STORAGE_KEY = 'event-swiper-selected';
const PROCESSED_IDS_KEY = 'event-swiper-processed-ids';
const CURRENT_INDEX_KEY = 'event-swiper-current-index';
const DATA_TIMESTAMP_KEY = 'event-swiper-data-timestamp';
const EVENTS_CACHE_KEY = 'event-swiper-events-cache';
const EVENTS_API = 'https://0jaku7mk0a.execute-api.eu-west-1.amazonaws.com/api/events/mu2025';
const SPEAKERS_API = 'https://0jaku7mk0a.execute-api.eu-west-1.amazonaws.com/api/speakers/mu2025';
const DATA_EXPIRY_DAYS = 4;

let selectedEvents = loadStoredSelections();
let processedIds = loadProcessedIds();

let isDragging = false;
let startX = 0;
let startY = 0;
let currentX = 0;
let currentY = 0;
let swipeDirectionDetermined = false;
let isVerticalScroll = false;

let lastAction = null; // Track last action for undo functionality
let actionInProgress = false; // Prevent double-actions
let isLoading = false; // Prevent interactions during data loading

// Store event listener references for cleanup
let currentCardListeners = null;

// --- Normalization & Persistence Helpers ---
function normalizeDateIso(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  const datePart = raw.includes('T') ? raw.split('T')[0] : raw;

  if (/^\d{8}$/.test(datePart)) {
    return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return datePart;
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(datePart)) {
    const [month, day, year] = datePart.split('/');
    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  console.warn(`Unrecognized dateIso format: "${value}"`);
  return '';
}

function normalizeTime(value) {
  if (value === null || value === undefined) return '';
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 4) return digits;       // HHmm
  if (digits.length === 3) return `0${digits}`; // Hmm -> HHmm
  if (digits.length === 6) return digits.slice(0, 4); // HHmmss -> HHmm
  if (!digits) return '';
  console.warn(`Unrecognized time format: "${value}"`);
  return '';
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = (dateStr || '').split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/* duplicate normalizeDateIso/normalizeTime removed */

function loadStoredSelections() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.warn('Failed to parse stored selections, clearing them.', error);
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

function saveSelections() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedEvents));
  } catch (error) {
    console.warn('Unable to persist selections.', error);
  }
}

function loadProcessedIds() {
  try {
    const raw = localStorage.getItem(PROCESSED_IDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(arr.map(String));
  } catch (error) {
    console.warn('Failed to load processed IDs.', error);
    return new Set();
  }
}

function saveProcessedIds() {
  try {
    localStorage.setItem(PROCESSED_IDS_KEY, JSON.stringify(Array.from(processedIds)));
  } catch (error) {
    console.warn('Unable to save processed IDs.', error);
  }
}

function loadSavedIndex() {
  try {
    const raw = localStorage.getItem(CURRENT_INDEX_KEY);
    return raw ? Math.max(parseInt(raw, 10) || 0, 0) : 0;
  } catch (error) {
    return 0;
  }
}

function saveCurrentIndex() {
  try {
    localStorage.setItem(CURRENT_INDEX_KEY, String(currentIndex));
  } catch (error) {
    // Non-fatal
  }
}

function shouldRefreshData() {
  try {
    const timestamp = localStorage.getItem(DATA_TIMESTAMP_KEY);
    if (!timestamp) return true;

    const lastFetch = new Date(parseInt(timestamp, 10));
    const now = new Date();
    const daysDiff = (now - lastFetch) / (1000 * 60 * 60 * 24);

    return daysDiff >= DATA_EXPIRY_DAYS;
  } catch (error) {
    console.warn('Error checking data freshness:', error);
    return true;
  }
}

function saveDataTimestamp() {
  try {
    localStorage.setItem(DATA_TIMESTAMP_KEY, Date.now().toString());
  } catch (error) {
    console.warn('Unable to persist data timestamp.', error);
  }
}

function loadCachedEvents() {
  try {
    const cached = localStorage.getItem(EVENTS_CACHE_KEY);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.warn('Failed to load cached events:', error);
    return null;
  }
}

function saveCachedEvents(eventsData) {
  try {
    localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(eventsData));
  } catch (error) {
    console.warn('Unable to cache events:', error);
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('Network error: Unable to connect to server. Check your internet connection.');
    }
    throw error;
  }
}

function updateButtonStates() {
  const hasEvents = currentIndex < events.length;
  document.getElementById('btn-dislike').disabled = !hasEvents;
  document.getElementById('btn-like').disabled = !hasEvents;
}

function updateUndoButton() {
  const undoBtn = document.getElementById('undo-btn');
  if (!undoBtn) return;
  if (lastAction && !actionInProgress) {
    undoBtn.classList.add('visible');
  } else {
    undoBtn.classList.remove('visible');
  }
}

function performUndo() {
  if (!lastAction || actionInProgress) return;

  const { type, eventData, index } = lastAction;

  if (type === 'like') {
    // Remove from selected events
    selectedEvents = selectedEvents.filter(e => e.eventId !== eventData.eventId);
    saveSelections();
    // Allow the event to be processed again
    processedIds.delete(String(eventData.eventId));
    saveProcessedIds();
  } else if (type === 'skip') {
    // Allow the event to be processed again
    processedIds.delete(String(eventData.eventId));
    saveProcessedIds();
  }

  // Go back to the previous card
  currentIndex = index;
  lastAction = null;
  updateCounter();
  showCurrentCard();
  updateUndoButton();
}

async function loadEvents(mode = 'initial') {
  const container = document.getElementById('card-container');
  const noMore = document.getElementById('no-more');
  const header = document.querySelector('.header');

  // Check if we should refresh data (auto-refresh if > 4 days old)
  const shouldRefresh = mode === 'refresh' || shouldRefreshData();

  if (!shouldRefresh && mode === 'initial') {
    console.log('Data is fresh, attempting to load from cache');
    const cachedEvents = loadCachedEvents();

    if (cachedEvents && Array.isArray(cachedEvents)) {
      // Always filter by processedIds on resume so handled events don't reappear
      events = cachedEvents.filter((ev) => !processedIds.has(String(ev.eventId)));
      currentIndex = 0;
      updateCounter();
      showCurrentCard();
      updateButtonStates();

      // Fade out header title and show counter after first load
      setTimeout(() => {
        header.classList.add('loaded');
      }, 800);
      return;
    }
    // If no cache, fall through to fetch
    console.log('No cached data found, fetching from API');
  }

  isLoading = true;
  container.classList.add('loading');
  noMore.style.display = 'none';
  updateButtonStates();

  try {
    const [eventsData, speakersData] = await Promise.all([
      fetchJson(EVENTS_API),
      fetchJson(SPEAKERS_API)
    ]);

    // Save timestamp after successful fetch
    saveDataTimestamp();

    if (!eventsData?.entities || !Array.isArray(eventsData.entities)) {
      throw new Error('Invalid events payload received.');
    }
    if (!speakersData?.entities || !Array.isArray(speakersData.entities)) {
      throw new Error('Invalid speakers payload received.');
    }

    const speakerMap = {};
    speakersData.entities.forEach((speaker) => {
      speakerMap[speaker.appSpeakerId] = {
        name: `${speaker.firstName || ''} ${speaker.lastName || ''}`.trim(),
        jobTitle: speaker.jobTitle || '',
        company: speaker.company || '',
        bio: speaker.speakerBiography || '',
        image: speaker.imageSrc || ''
      };
    });

    const mapped = eventsData.entities.map((event) => {
      const normalizedDateIso = normalizeDateIso(event.dateIso);
      const normalizedStart = normalizeTime(event.startTime);
      const normalizedEnd = normalizeTime(event.endTime);

      const speakers = (event.speakerData || []).map((sd) => {
        const info = speakerMap[sd.appSpeakerId] || {};
        return {
          ...info,
          type: sd.speakerType
        };
      }).filter((s) => s.name);

      return {
        eventId: event.eventId || `temp-${Date.now()}-${Math.random()}`,
        title: event.title || 'Untitled Event',
        description: event.description || '',
        date: event.dateLong || 'Date TBA',
        dateIso: normalizedDateIso,
        rawDateIso: event.dateIso || '',
        startTime: normalizedStart,
        endTime: normalizedEnd,
        venue: event.eventVenue || 'Venue TBA',
        eventType: event.eventTypeName || '',
        track: event.track || '',
        topics: Array.isArray(event.eventTopics) ? event.eventTopics : [],
        speakers
      };
    });

    // Sort events by date (ISO format) and then by start time
    mapped.sort((a, b) => {
      // First sort by date
      if (a.dateIso && b.dateIso && a.dateIso !== b.dateIso) {
        return a.dateIso.localeCompare(b.dateIso);
      }
      // Then sort by start time
      if (a.startTime && b.startTime) {
        return a.startTime.localeCompare(b.startTime);
      }
      return 0;
    });

    // Filter out already processed events so they don't reappear after refresh
    const remaining = mapped.filter((ev) => !processedIds.has(String(ev.eventId)));
    events = remaining;

    const eventMap = new Map(mapped.map((event) => [event.eventId, event]));
    const refreshedSelections = selectedEvents
      .map((selected) => eventMap.get(selected.eventId))
      .filter(Boolean);

    const selectionsChanged = refreshedSelections.length !== selectedEvents.length ||
      refreshedSelections.some((event, index) => event !== selectedEvents[index]);

    if (selectionsChanged) {
      selectedEvents = refreshedSelections;
      saveSelections();
    }

    currentIndex = 0;
    saveCurrentIndex();

    // Cache the processed events
    saveCachedEvents(events);

    updateCounter();
    showCurrentCard();
    updateButtonStates();

    // Fade out header title and show counter after first load
    if (mode === 'initial') {
      setTimeout(() => {
        header.classList.add('loaded');
      }, 800);
    }

    if (mode === 'refresh') {
      alert('✅ Events refreshed from the remote API.');
    }
  } catch (error) {
    console.error('Failed to load events:', error);
    events = [];
    updateCounter();
    showCurrentCard();
    updateButtonStates();
    alert('Failed to load events. Please check your connection and try again.');
  } finally {
    isLoading = false;
    container.classList.remove('loading');
  }
}

function updateCounter() {
  document.getElementById('selected-count').textContent = selectedEvents.length;
  document.getElementById('remaining-count').textContent = Math.max(events.length - currentIndex, 0);
}

function showCurrentCard() {
  const container = document.getElementById('card-container');
  const noMore = document.getElementById('no-more');

  container.querySelectorAll('.card').forEach((card) => card.remove());

  if (currentIndex >= events.length) {
    noMore.style.display = 'block';
    updateCounter();
    updateButtonStates();
    return;
  }

  noMore.style.display = 'none';
  updateButtonStates();
  const event = events[currentIndex];

  const card = document.createElement('div');
  card.className = 'card';
  const description = stripHtml(event.description);

  // Prioritize primary badge (event type or track)
  const primaryBadge = event.eventType || event.track;
  const secondaryBadges = event.topics && event.topics.length > 0 ? event.topics.slice(0, 2).filter(Boolean) : [];

  card.innerHTML = `
    <div class="card-content">
      <div class="card-header">
        <h2 class="event-title">${escapeHtml(event.title)}</h2>
        <div class="event-meta">
          <div class="meta-item datetime">
            <span class="meta-icon">📅</span>
            <span>${formatDateTime(event.date, event.startTime, event.endTime)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-icon">📍</span>
            <span>${escapeHtml(event.venue)}</span>
          </div>
          ${primaryBadge || secondaryBadges.length > 0 ? `
            <div class="meta-item">
              ${primaryBadge ? `<span class="badge">${escapeHtml(primaryBadge)}</span>` : ''}
              ${secondaryBadges.map((topic) => `<span class="badge secondary">${escapeHtml(topic)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>

      <div class="event-description">
        ${escapeHtml(description)}
      </div>

      ${event.speakers && event.speakers.length ? `
        <div class="speakers-section">
          <h3 class="speakers-title">Speakers</h3>
          ${event.speakers.map((speaker) => {
            const companyTitle = [speaker.company, speaker.jobTitle].filter(Boolean).join(' • ');
            const speakerType = speaker.type ? ` (${speaker.type})` : '';
            return `
              <div class="speaker">
                ${companyTitle ? `<div class="speaker-role">${escapeHtml(companyTitle)}</div>` : ''}
                <div class="speaker-name">${escapeHtml(speaker.name)}${speakerType ? `<span class="speaker-type">${escapeHtml(speakerType)}</span>` : ''}</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `;

  container.appendChild(card);
  attachSwipeListeners(card);
}

function formatTime(time) {
  if (!time || time.length !== 4) return time;
  const hours = parseInt(time.slice(0, 2), 10);
  const minutes = time.slice(2);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours}:${minutes}${period}`;
}

function formatDateTime(dateStr, startTime, endTime) {
  // Convert "Sunday 26 October" to "Oct 26"
  const parts = dateStr.split(' ');
  let month = '';
  let day = '';

  if (parts.length >= 3) {
    day = parts[1];
    const fullMonth = parts[2];
    const monthMap = {
      'January': 'Jan', 'February': 'Feb', 'March': 'Mar', 'April': 'Apr',
      'May': 'May', 'June': 'Jun', 'July': 'Jul', 'August': 'Aug',
      'September': 'Sep', 'October': 'Oct', 'November': 'Nov', 'December': 'Dec'
    };
    month = monthMap[fullMonth] || fullMonth;
  }

  const start = formatTime(startTime);
  const end = formatTime(endTime);

  return `${month} ${day} @ ${start} - ${end}`;
}

function formatExportTime(time) {
  if (!time || time.length !== 4) return time;
  return `${time.slice(0, 2)}:${time.slice(2)}`;
}

function stripHtml(html) {
  if (!html) return '';
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  } catch (error) {
    console.warn('Failed to strip HTML, returning empty string', error);
    return '';
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function cleanupSwipeListeners() {
  if (currentCardListeners) {
    const { card, handlers } = currentCardListeners;
    card.removeEventListener('mousedown', handlers.handleDragStart);
    document.removeEventListener('mousemove', handlers.handleDragMove);
    document.removeEventListener('mouseup', handlers.handleDragEnd);
    card.removeEventListener('touchstart', handlers.handleDragStart);
    document.removeEventListener('touchmove', handlers.handleDragMove);
    document.removeEventListener('touchend', handlers.handleDragEnd);
    currentCardListeners = null;
  }
}

function attachSwipeListeners(card) {
  // Clean up any existing listeners first
  cleanupSwipeListeners();

  const handlers = {
    handleDragStart: handleDragStart.bind(null),
    handleDragMove: handleDragMove.bind(null),
    handleDragEnd: handleDragEnd.bind(null)
  };

  card.addEventListener('mousedown', handlers.handleDragStart);
  document.addEventListener('mousemove', handlers.handleDragMove);
  document.addEventListener('mouseup', handlers.handleDragEnd);

  card.addEventListener('touchstart', handlers.handleDragStart, { passive: true });
  document.addEventListener('touchmove', handlers.handleDragMove, { passive: false });
  document.addEventListener('touchend', handlers.handleDragEnd);

  // Store reference for cleanup
  currentCardListeners = { card, handlers };
}

function handleDragStart(event) {
  // Don't start dragging if loading
  if (isLoading) return;

  // Reset swipe state
  isDragging = true;
  swipeDirectionDetermined = false;
  isVerticalScroll = false;

  // Store initial touch/mouse position
  if (event.type.includes('mouse')) {
    startX = event.clientX;
    startY = event.clientY;
  } else {
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  }

  currentX = startX;
  currentY = startY;
}

function handleDragMove(event) {
  if (!isDragging) return;

  // Get current position
  if (event.type.includes('touch')) {
    currentX = event.touches[0].clientX;
    currentY = event.touches[0].clientY;
  } else {
    currentX = event.clientX;
    currentY = event.clientY;
  }

  const diffX = currentX - startX;
  const diffY = currentY - startY;

  // Determine swipe direction on first significant movement
  if (!swipeDirectionDetermined && (Math.abs(diffX) > 10 || Math.abs(diffY) > 10)) {
    swipeDirectionDetermined = true;

    // Check if user is trying to scroll vertically
    const target = event.target || event.touches?.[0]?.target;
    const description = target?.closest('.event-description');
    const speakers = target?.closest('.speakers-section');

    // If in scrollable area AND moving more vertically than horizontally, it's a scroll
    if ((description || speakers) && Math.abs(diffY) > Math.abs(diffX)) {
      isVerticalScroll = true;
      isDragging = false; // Stop card dragging, allow native scroll
      return;
    }
  }

  // If determined to be vertical scroll, don't interfere
  if (isVerticalScroll) return;

  // Prevent default for horizontal swipes on touch devices
  if (event.type.includes('touch') && Math.abs(diffX) > Math.abs(diffY)) {
    event.preventDefault();
  }

  const card = document.querySelector('.card');
  if (!card) return;

  const rotation = diffX / 20;
  card.style.transform = `translateX(${diffX}px) rotate(${rotation}deg)`;

  if (diffX < -50) {
    card.classList.add('swiping-left');
    card.classList.remove('swiping-right');
  } else if (diffX > 50) {
    card.classList.add('swiping-right');
    card.classList.remove('swiping-left');
  } else {
    card.classList.remove('swiping-left', 'swiping-right');
  }
}

function handleDragEnd() {
  // Reset state
  const wasDragging = isDragging;
  isDragging = false;
  swipeDirectionDetermined = false;
  isVerticalScroll = false;

  if (!wasDragging) return;

  const diffX = currentX - startX;
  const card = document.querySelector('.card');
  if (!card) return;

  if (Math.abs(diffX) > 100) {
    if (diffX > 0) {
      handleLike();
    } else {
      handleDislike();
    }
  } else {
    card.style.transform = '';
    card.classList.remove('swiping-left', 'swiping-right');
  }
}

function handleLike() {
  if (actionInProgress || isLoading) return;

  const event = events[currentIndex];
  if (!event) return;

  actionInProgress = true;
  const wasAlreadySelected = selectedEvents.find((item) => item.eventId === event.eventId);

  if (!wasAlreadySelected) {
    selectedEvents.push(event);
    saveSelections();
    processedIds.add(String(event.eventId));
    saveProcessedIds();
    lastAction = { type: 'like', eventData: event, index: currentIndex };
  } else {
    lastAction = { type: 'skip', eventData: event, index: currentIndex };
  }

  updateUndoButton();
  animateCardExit('right');
}

function handleDislike() {
  if (actionInProgress || isLoading) return;

  const event = events[currentIndex];
  if (!event) return;

  actionInProgress = true;
  processedIds.add(String(event.eventId));
  saveProcessedIds();
  lastAction = { type: 'skip', eventData: event, index: currentIndex };
  updateUndoButton();
  animateCardExit('left');
}

function animateCardExit(direction) {
  const card = document.querySelector('.card');
  if (!card) {
    actionInProgress = false;
    return;
  }

  const translateX = direction === 'right' ? '150%' : '-150%';
  const rotation = direction === 'right' ? '30deg' : '-30deg';

  card.style.transition = 'all 0.3s ease';
  card.style.transform = `translateX(${translateX}) rotate(${rotation})`;

  setTimeout(() => {
    currentIndex += 1;
    updateCounter();
    showCurrentCard();
    saveCurrentIndex();
    actionInProgress = false;
  }, 300);
}

document.addEventListener('keydown', (event) => {
  // Don't handle keyboard shortcuts during loading
  if (isLoading) return;

  // Undo with Ctrl+Z or Cmd+Z
  if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
    event.preventDefault();
    performUndo();
    return;
  }

  if (currentIndex >= events.length) return;

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    handleDislike();
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    handleLike();
  }
});

const btnDislike = document.getElementById('btn-dislike');
if (btnDislike) {
  btnDislike.addEventListener('click', () => {
    if (currentIndex < events.length) {
      handleDislike();
    }
  });
}

const btnLike = document.getElementById('btn-like');
if (btnLike) {
  btnLike.addEventListener('click', () => {
    if (currentIndex < events.length) {
      handleLike();
    }
  });
}

function showSelectedEventsOverlay() {
  const overlay = document.getElementById('selected-overlay');
  const overlayBody = document.getElementById('overlay-body');

  if (selectedEvents.length === 0) {
    overlayBody.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No events selected yet</div>
      </div>
    `;
  } else {
    // Sort selected events by date and time
    const sortedEvents = [...selectedEvents].sort((a, b) => {
      if (a.dateIso && b.dateIso && a.dateIso !== b.dateIso) {
        return a.dateIso.localeCompare(b.dateIso);
      }
      if (a.startTime && b.startTime) {
        return a.startTime.localeCompare(b.startTime);
      }
      return 0;
    });

    overlayBody.innerHTML = sortedEvents.map((event) => `
      <div class="selected-event-card">
        <div class="selected-event-title">${escapeHtml(event.title)}</div>
        <div class="selected-event-meta">
          <div class="selected-event-meta-item">📅 ${formatDateTime(event.date, event.startTime, event.endTime)}</div>
          <div class="selected-event-meta-item">📍 ${escapeHtml(event.venue)}</div>
          ${event.speakers && event.speakers.length ? `
            <div class="selected-event-meta-item">
              👥 ${event.speakers.map(s => escapeHtml(s.name)).join(', ')}
            </div>
          ` : ''}
        </div>
      </div>
    `).join('');
  }

  // Reset scroll position
  overlayBody.scrollTop = 0;

  // Show overlay with display, then add visible class for animation
  overlay.style.display = 'flex';
  // Force reflow to ensure animation triggers
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });
  });
}

function hideSelectedEventsOverlay() {
  const overlay = document.getElementById('selected-overlay');
  overlay.classList.remove('visible');

  // Wait for animation to complete before hiding
  setTimeout(() => {
    if (!overlay.classList.contains('visible')) {
      overlay.style.display = 'none';
    }
  }, 500); // Match the transition duration
}

const viewSelectedBtn = document.getElementById('view-selected');
if (viewSelectedBtn) {
  viewSelectedBtn.addEventListener('click', () => {
    // If the overlay markup exists, use it. Otherwise, fall back to alert summary.
    const overlay = document.getElementById('selected-overlay');
    const overlayBody = document.getElementById('overlay-body');
    if (overlay && overlayBody) {
      showSelectedEventsOverlay();
    } else {
      if (selectedEvents.length === 0) {
        alert('No events selected yet');
      } else {
        const summary = selectedEvents.map((e, i) => `${i + 1}. ${e.title}\n   ${formatDateTime(e.date, e.startTime, e.endTime)}\n   ${e.venue}`).join('\n\n');
        alert(`Selected Events (${selectedEvents.length}):\n\n${summary}`);
      }
    }
  });
}

const closeOverlayBtn = document.getElementById('close-overlay');
if (closeOverlayBtn) {
  closeOverlayBtn.addEventListener('click', () => {
    hideSelectedEventsOverlay();
  });
}

const selectedOverlayEl = document.getElementById('selected-overlay');
if (selectedOverlayEl) {
  selectedOverlayEl.addEventListener('click', (event) => {
    if (event.target.id === 'selected-overlay') {
      hideSelectedEventsOverlay();
    }
  });
}

// About overlay functions
function showAboutOverlay() {
  const overlay = document.getElementById('about-overlay');

  // Show overlay with display, then add visible class for animation
  overlay.style.display = 'flex';
  // Force reflow to ensure animation triggers
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });
  });
}

function hideAboutOverlay() {
  const overlay = document.getElementById('about-overlay');
  overlay.classList.remove('visible');

  // Wait for animation to complete before hiding
  setTimeout(() => {
    if (!overlay.classList.contains('visible')) {
      overlay.style.display = 'none';
    }
  }, 500); // Match the transition duration
}

const aboutBtn = document.getElementById('about');
if (aboutBtn) {
  aboutBtn.addEventListener('click', () => {
    showAboutOverlay();
  });
}
const closeAboutBtn = document.getElementById('close-about');
if (closeAboutBtn) {
  closeAboutBtn.addEventListener('click', () => {
    hideAboutOverlay();
  });
}
const aboutOverlayEl = document.getElementById('about-overlay');
if (aboutOverlayEl) {
  aboutOverlayEl.addEventListener('click', (event) => {
    if (event.target.id === 'about-overlay') {
      hideAboutOverlay();
    }
  });
}

const undoBtnEl = document.getElementById('undo-btn');
if (undoBtnEl) {
  undoBtnEl.addEventListener('click', () => {
    performUndo();
  });
}

const resetBtn = document.getElementById('reset');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset all selections and start over?')) return;

    selectedEvents = [];
    saveSelections();
    processedIds = new Set();
    saveProcessedIds();
    currentIndex = 0;
    saveCurrentIndex();
    lastAction = null;
    updateCounter();
    showCurrentCard();
    updateUndoButton();
  });
}

// Export overlay functions
function showExportOverlay() {
  const overlay = document.getElementById('export-overlay');
  const countElement = document.getElementById('export-count');

  // Update count
  const count = selectedEvents.length;
  countElement.textContent = `${count} event${count !== 1 ? 's' : ''} ready to export`;

  // Show overlay with display, then add visible class for animation
  overlay.style.display = 'flex';
  // Force reflow to ensure animation triggers
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });
  });
}

function hideExportOverlay() {
  const overlay = document.getElementById('export-overlay');
  overlay.classList.remove('visible');

  // Wait for animation to complete before hiding
  setTimeout(() => {
    if (!overlay.classList.contains('visible')) {
      overlay.style.display = 'none';
    }
  }, 500); // Match the transition duration
}

function generateICS() {
  if (selectedEvents.length === 0) {
    alert('No events to export!');
    return;
  }

  // ICS file format helper functions
  const formatICSDate = (dateIso, time, label = 'event') => {
    const normalizedDate = normalizeDateIso(dateIso);
    const normalizedTime = normalizeTime(time);

    if (!normalizedDate) {
      console.warn(`Skipping ${label}: unable to parse date value "${dateIso}".`);
      return '';
    }

    if (!normalizedTime) {
      console.warn(`Skipping ${label}: unable to parse time value "${time}".`);
      return '';
    }

    const compactDate = normalizedDate.replace(/-/g, '');
    return `${compactDate}T${normalizedTime}00`;
  };

  const escapeICS = (text) => {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  };

  const foldLine = (line) => {
    // ICS spec requires lines to be max 75 characters, folded with CRLF + space
    if (line.length <= 75) return line;

    const lines = [];
    let currentLine = line;
    while (currentLine.length > 75) {
      lines.push(currentLine.substring(0, 75));
      currentLine = ' ' + currentLine.substring(75);
    }
    lines.push(currentLine);
    return lines.join('\r\n');
  };

  // Generate ICS content (includes VTIMEZONE for America/Los_Angeles)
  let icsContent = 'BEGIN:VCALENDAR\r\n';
  icsContent += 'VERSION:2.0\r\n';
  icsContent += 'PRODID:-//M2020 Events//Money2020 Events//EN\r\n';
  icsContent += 'CALSCALE:GREGORIAN\r\n';
  icsContent += 'METHOD:PUBLISH\r\n';
  icsContent += 'X-WR-TIMEZONE:America/Los_Angeles\r\n';
  icsContent += 'X-WR-CALNAME:Money20/20 Selected Events\r\n';
  icsContent += 'BEGIN:VTIMEZONE\r\n';
  icsContent += 'TZID:America/Los_Angeles\r\n';
  icsContent += 'X-LIC-LOCATION:America/Los_Angeles\r\n';
  icsContent += 'BEGIN:DAYLIGHT\r\n';
  icsContent += 'TZOFFSETFROM:-0800\r\n';
  icsContent += 'TZOFFSETTO:-0700\r\n';
  icsContent += 'TZNAME:PDT\r\n';
  icsContent += 'DTSTART:19700308T020000\r\n';
  icsContent += 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\n';
  icsContent += 'END:DAYLIGHT\r\n';
  icsContent += 'BEGIN:STANDARD\r\n';
  icsContent += 'TZOFFSETFROM:-0700\r\n';
  icsContent += 'TZOFFSETTO:-0800\r\n';
  icsContent += 'TZNAME:PST\r\n';
  icsContent += 'DTSTART:19701101T020000\r\n';
  icsContent += 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\n';
  icsContent += 'END:STANDARD\r\n';
  icsContent += 'END:VTIMEZONE\r\n';

  let skippedEvents = 0;
  let exportedEvents = 0;

  selectedEvents.forEach((event) => {
    const normalizedDate = event.dateIso || normalizeDateIso(event.rawDateIso);
    const startNorm = normalizeTime(event.startTime);
    const endNorm = normalizeTime(event.endTime);
    let endDateIso = normalizedDate;

    // Handle events crossing midnight: if end < start, roll end date to next day
    if (startNorm && endNorm && parseInt(endNorm, 10) < parseInt(startNorm, 10)) {
      endDateIso = addDaysIso(normalizedDate, 1);
    }

    const startDateTime = formatICSDate(normalizedDate, startNorm, `${event.title} (start)`);
    let endDateTime = formatICSDate(endDateIso, endNorm, `${event.title} (end)`);

    // If end time cannot be parsed, fall back to start time so event still appears
    if (!endDateTime && startDateTime) {
      endDateTime = startDateTime;
    }

    if (!startDateTime || !endDateTime) {
      console.warn(`Skipping event "${event.title}" due to invalid date/time. dateIso: "${normalizedDate}", startTime: "${event.startTime}", endTime: "${event.endTime}"`);
      skippedEvents++;
      return;
    }

    exportedEvents++;

    // Build description with speakers and details
    let description = stripHtml(event.description) || '';

    if (event.speakers && event.speakers.length > 0) {
      description += '\n\nSpeakers:\n';
      event.speakers.forEach((speaker) => {
        const speakerInfo = [speaker.name, speaker.jobTitle, speaker.company]
          .filter(Boolean)
          .join(' - ');
        const speakerType = speaker.type ? ` (${speaker.type})` : '';
        description += `- ${speakerInfo}${speakerType}\n`;
      });
    }

    // Add event type and topics
    const eventMeta = [];
    if (event.eventType) eventMeta.push(event.eventType);
    if (event.topics && event.topics.length > 0) {
      eventMeta.push(...event.topics);
    }
    if (eventMeta.length > 0) {
      description += `\n\nTopics: ${eventMeta.join(', ')}`;
    }

    const uid = `${event.eventId}@money2020-event-swiper`;
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    icsContent += 'BEGIN:VEVENT\r\n';
    icsContent += foldLine(`UID:${uid}`) + '\r\n';
    icsContent += foldLine(`DTSTAMP:${timestamp}`) + '\r\n';
    icsContent += foldLine(`DTSTART;TZID=America/Los_Angeles:${startDateTime}`) + '\r\n';
    icsContent += foldLine(`DTEND;TZID=America/Los_Angeles:${endDateTime}`) + '\r\n';
    icsContent += foldLine(`SUMMARY:${escapeICS(event.title)}`) + '\r\n';
    icsContent += foldLine(`LOCATION:${escapeICS(event.venue)}`) + '\r\n';
    icsContent += foldLine(`DESCRIPTION:${escapeICS(description)}`) + '\r\n';
    icsContent += 'STATUS:CONFIRMED\r\n';
    icsContent += 'END:VEVENT\r\n';
  });

  icsContent += 'END:VCALENDAR\r\n';

  // Show alert if no events were exported
  if (exportedEvents === 0) {
    alert(`❌ Unable to export events.\n\nAll ${selectedEvents.length} selected events have invalid date/time data.\n\nPlease check the browser console for details.`);
    return;
  }

  // Show warning if some events were skipped
  if (skippedEvents > 0) {
    console.warn(`⚠️ Exported ${exportedEvents} events, skipped ${skippedEvents} events with invalid dates.`);
  }

  // Download ICS file
  const filename = `money2020-events-${Date.now()}.ics`;
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  // Show success message
  if (skippedEvents > 0) {
    alert(`✅ Exported ${exportedEvents} of ${selectedEvents.length} events.\n\n${skippedEvents} events were skipped due to invalid dates.\n\nCheck the browser console for details.`);
  } else {
    alert(`✅ Exported ${exportedEvents} events to your calendar file.`);
  }

  // Close the overlay after download
  setTimeout(() => {
    hideExportOverlay();
  }, 500);
}

function handleExportClick() {
  if (selectedEvents.length === 0) {
    alert('No events to export!');
    return;
  }
  const overlay = document.getElementById('export-overlay');
  const countEl = document.getElementById('export-count');
  if (overlay && countEl) {
    showExportOverlay();
  } else {
    generateICS();
  }
}

const exportBtn = document.getElementById('export');
if (exportBtn) {
  exportBtn.addEventListener('click', handleExportClick);
}

const exportEndBtn = document.getElementById('export-end');
if (exportEndBtn) {
  exportEndBtn.addEventListener('click', handleExportClick);
}

const closeExportBtn = document.getElementById('close-export');
if (closeExportBtn) {
  closeExportBtn.addEventListener('click', () => {
    hideExportOverlay();
  });
}

const exportOverlayEl = document.getElementById('export-overlay');
if (exportOverlayEl) {
  exportOverlayEl.addEventListener('click', (event) => {
    if (event.target.id === 'export-overlay') {
      hideExportOverlay();
    }
  });
}

const downloadIcsBtn = document.getElementById('download-ics');
if (downloadIcsBtn) {
  downloadIcsBtn.addEventListener('click', () => {
    generateICS();
  });
}

loadEvents();
