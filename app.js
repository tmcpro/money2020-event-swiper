let events = [];
let currentIndex = 0;

const STORAGE_KEY = 'event-swiper-selected';
const DATA_TIMESTAMP_KEY = 'event-swiper-data-timestamp';
const EVENTS_CACHE_KEY = 'event-swiper-events-cache';
const EVENTS_API = 'https://0jaku7mk0a.execute-api.eu-west-1.amazonaws.com/api/events/mu2025';
const SPEAKERS_API = 'https://0jaku7mk0a.execute-api.eu-west-1.amazonaws.com/api/speakers/mu2025';
const DATA_EXPIRY_DAYS = 4;

let selectedEvents = loadStoredSelections();

let isDragging = false;
let startX = 0;
let currentX = 0;

let lastAction = null; // Track last action for undo functionality
let actionInProgress = false; // Prevent double-actions
let isLoading = false; // Prevent interactions during data loading

// Store event listener references for cleanup
let currentCardListeners = null;

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
      events = cachedEvents;
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

    events = eventsData.entities.map((event) => {
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
        dateIso: event.dateIso || '',
        startTime: event.startTime || '',
        endTime: event.endTime || '',
        venue: event.eventVenue || 'Venue TBA',
        eventType: event.eventTypeName || '',
        track: event.track || '',
        topics: Array.isArray(event.eventTopics) ? event.eventTopics : [],
        speakers
      };
    });

    // Sort events by date (ISO format) and then by start time
    events.sort((a, b) => {
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

    const validIds = new Set(events.map((event) => event.eventId));
    const filteredSelections = selectedEvents.filter((event) => validIds.has(event.eventId));
    if (filteredSelections.length !== selectedEvents.length) {
      selectedEvents = filteredSelections;
      saveSelections();
    }

    currentIndex = 0;

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
  // Don't start dragging if loading or if user is interacting with scrollable content
  if (isLoading) return;

  const target = event.target;
  const description = target.closest('.event-description');
  const speakers = target.closest('.speakers-section');

  if (description || speakers) {
    return; // Allow scrolling in these areas
  }

  isDragging = true;
  startX = event.type.includes('mouse') ? event.clientX : event.touches[0].clientX;
  currentX = startX;
}

function handleDragMove(event) {
  if (!isDragging) return;

  if (event.type.includes('touch')) {
    currentX = event.touches[0].clientX;
    event.preventDefault();
  } else {
    currentX = event.clientX;
  }

  const diffX = currentX - startX;
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
  if (!isDragging) return;
  isDragging = false;

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

document.getElementById('btn-dislike').addEventListener('click', () => {
  if (currentIndex < events.length) {
    handleDislike();
  }
});

document.getElementById('btn-like').addEventListener('click', () => {
  if (currentIndex < events.length) {
    handleLike();
  }
});

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

document.getElementById('view-selected').addEventListener('click', () => {
  showSelectedEventsOverlay();
});

document.getElementById('close-overlay').addEventListener('click', () => {
  hideSelectedEventsOverlay();
});

// Close overlay when clicking on background
document.getElementById('selected-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'selected-overlay') {
    hideSelectedEventsOverlay();
  }
});

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

document.getElementById('about').addEventListener('click', () => {
  showAboutOverlay();
});

document.getElementById('close-about').addEventListener('click', () => {
  hideAboutOverlay();
});

// Close about overlay when clicking on background
document.getElementById('about-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'about-overlay') {
    hideAboutOverlay();
  }
});

document.getElementById('undo-btn').addEventListener('click', () => {
  performUndo();
});

document.getElementById('reset').addEventListener('click', () => {
  if (!confirm('Reset all selections and start over?')) return;

  selectedEvents = [];
  saveSelections();
  currentIndex = 0;
  lastAction = null;
  updateCounter();
  showCurrentCard();
  updateUndoButton();
});

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
  const formatICSDate = (dateIso, time) => {
    // dateIso format: "2025-10-26", time format: "0900"
    if (!dateIso || !time) return '';

    // Validate dateIso format (must be YYYY-MM-DD with length 10)
    if (dateIso.length < 10 || dateIso.charAt(4) !== '-' || dateIso.charAt(7) !== '-') {
      console.warn(`Invalid dateIso format: "${dateIso}". Expected YYYY-MM-DD format.`);
      return '';
    }

    // Validate time format (must be 4 digits)
    if (time.length !== 4) {
      console.warn(`Invalid time format: "${time}". Expected 4-digit format like "0900".`);
      return '';
    }

    const year = dateIso.substring(0, 4);
    const month = dateIso.substring(5, 7);
    const day = dateIso.substring(8, 10);
    const hour = time.substring(0, 2);
    const minute = time.substring(2, 4);

    // Validate extracted values are numbers
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day) ||
        !/^\d{2}$/.test(hour) || !/^\d{2}$/.test(minute)) {
      console.warn(`Invalid date/time components. Year: ${year}, Month: ${month}, Day: ${day}, Hour: ${hour}, Minute: ${minute}`);
      return '';
    }

    // Format: YYYYMMDDTHHMMSS in Pacific Time
    return `${year}${month}${day}T${hour}${minute}00`;
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

  // Generate ICS content
  let icsContent = 'BEGIN:VCALENDAR\r\n';
  icsContent += 'VERSION:2.0\r\n';
  icsContent += 'PRODID:-//M2020 Events//Money2020 Events//EN\r\n';
  icsContent += 'CALSCALE:GREGORIAN\r\n';
  icsContent += 'METHOD:PUBLISH\r\n';
  icsContent += 'X-WR-TIMEZONE:America/Los_Angeles\r\n';
  icsContent += 'X-WR-CALNAME:Money20/20 Selected Events\r\n';

  selectedEvents.forEach((event) => {
    const startDateTime = formatICSDate(event.dateIso, event.startTime);
    const endDateTime = formatICSDate(event.dateIso, event.endTime);

    // Skip events with invalid date/time data
    if (!startDateTime || !endDateTime) {
      console.warn(`Skipping event "${event.title}" due to invalid date/time. dateIso: "${event.dateIso}", startTime: "${event.startTime}", endTime: "${event.endTime}"`);
      return;
    }

    // Build description with speakers and details
    let description = stripHtml(event.description) || '';

    if (event.speakers && event.speakers.length > 0) {
      description += '\\n\\nSpeakers:\\n';
      event.speakers.forEach((speaker) => {
        const speakerInfo = [speaker.name, speaker.jobTitle, speaker.company]
          .filter(Boolean)
          .join(' - ');
        const speakerType = speaker.type ? ` (${speaker.type})` : '';
        description += `- ${speakerInfo}${speakerType}\\n`;
      });
    }

    // Add event type and topics
    const eventMeta = [];
    if (event.eventType) eventMeta.push(event.eventType);
    if (event.topics && event.topics.length > 0) {
      eventMeta.push(...event.topics);
    }
    if (eventMeta.length > 0) {
      description += `\\n\\nTopics: ${eventMeta.join(', ')}`;
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

  // Close the overlay after download
  setTimeout(() => {
    hideExportOverlay();
  }, 500);
}

document.getElementById('export').addEventListener('click', () => {
  if (selectedEvents.length === 0) {
    alert('No events to export!');
    return;
  }
  showExportOverlay();
});

document.getElementById('close-export').addEventListener('click', () => {
  hideExportOverlay();
});

// Close export overlay when clicking on background
document.getElementById('export-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'export-overlay') {
    hideExportOverlay();
  }
});

document.getElementById('download-ics').addEventListener('click', () => {
  generateICS();
});

loadEvents();
