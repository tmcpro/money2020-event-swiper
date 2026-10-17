/*
 * venues.js - venue/room resolver for M2020 Event Swiper (Money20/20 USA 2026).
 *
 * UMD: module.exports in Node (Pages Functions / tests), window.M2020Venues in the browser.
 * Classic script, no dependencies, safe to load via file://.
 *
 * API
 *   M2020Venues.resolve(venueName) -> {
 *     venue,      // original venue string (trimmed) or '' when missing
 *     room,       // room / stage name, e.g. "Galileo 1001-1003", "Exchange Stage"
 *     area,       // summit / zone, e.g. "Intelligence Summit", "MoneyPot", "The Intersection" ('' when none)
 *     building,   // "The Venetian Expo", "The Venetian Resort", "Caesars Palace"
 *     level,      // floor/level note when a reliable source states it, else ''
 *     address,    // full street address
 *     offsite,    // true when NOT inside The Venetian Expo
 *     mapUrl,     // per-room official expofp floor-plan link (or Google Maps link for OMNIA), null if none
 *     mapsUrl,    // Google Maps search URL for the street address
 *     group,      // group id for filter UI (see GROUPS)
 *     groupLabel, // human label of the group
 *     location,   // ready-made one-line LOCATION string: "room, area, building, address"
 *     known       // false when the venue was not recognised and defaults were used
 *   }
 *   Never throws. Matching ignores case, punctuation, "&"/"and" and "@"/"at" differences.
 *   Unknown/empty venue -> main venue (The Venetian Expo) address, mapUrl null, group 'other'.
 *
 *   M2020Venues.list()        -> array of resolve() results for every known venue (schedule order of GROUPS)
 *   M2020Venues.groups()      -> [{id, label, venues:[venueName...]}] in display order
 *   M2020Venues.groupOf(name) -> group id string
 *   M2020Venues.GROUPS        -> [{id, label}] display order
 *   M2020Venues.ADDRESSES     -> address constants
 *
 * SOURCES (re-verified by web search 2026-10-17)
 *   - Event dates/venue: Money20/20 USA 2026, Oct 18-21 2026, The Venetian Expo & The Venetian Resort, Las Vegas
 *       https://navan.com/blog/money20-20-guide
 *       https://sphinxhq.com/blog-posts/money2020-usa-2026-guide
 *       https://eventbrowse.com/venue/the-venetian-conference-and-expo-center/
 *   - The Venetian Expo street address: 201 Sands Avenue, Las Vegas, NV 89169
 *       https://en.wikipedia.org/wiki/Venetian_Expo (infobox: 201 Sands Avenue)
 *       https://thevendry.com/venue/6545/the-venetian-expo-las-vegas-nv (201 Sands Ave, Las Vegas, NV 89169)
 *       https://www.fair-point.com/en/venues/the-venetian-expo?id=271 (201 Sands Avenue, Las Vegas, NV 89169)
 *     Note: one guide (sphinxhq) lists the resort address 3355 Las Vegas Blvd S for the Expo; the Expo's own
 *     street address is 201 Sands Ave, which is what we use for all in-Expo rooms.
 *   - Galileo / Marco Polo / Casanova ballrooms: "Located on Level 1 ... Galileo is located next to Marco Polo
 *     and Casanova" - https://www.venetianlasvegas.com/meetings/planning/spaces/ballroom-venues/galileo.html
 *     and https://www.venetianlasvegas.com/meetings/planning/spaces/ballroom-venues/casanova.html
 *   - The Venetian Resort (Chica, Yardbird, Money Row / Sugarcane): 3355 S Las Vegas Blvd, Las Vegas, NV 89109
 *       https://en.wikipedia.org/wiki/The_Venetian_Las_Vegas
 *       https://lasvegaswonders.com/restaurants/yardbird/ (Yardbird inside The Venetian Resort, Restaurant Row)
 *   - OMNIA Nightclub, Caesars Palace: 3570 S Las Vegas Blvd, Las Vegas, NV 89109
 *       https://taogroup.com/?p=229237 (OMNIA FAQ: Caesars Palace, 3570 S Las Vegas Blvd, Las Vegas, NV 89109)
 *       https://www.eventworld.com/omnia-nightclub-las-vegas-tickets/venue/10027
 *     Note: the Wikipedia infobox for Omnia shows "3750", an apparent typo; 3570 is Caesars Palace's address.
 *   - Floor-map links: official Money20/20 USA 2026 expofp floor plan (money2020usa26.expofp.com), one per venue;
 *     OMNIA uses a Google Maps link because it is off-site; "Closed Door Roundtable" has no public location.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.M2020Venues = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ADDRESSES = {
    expo: 'The Venetian Expo, 201 Sands Ave, Las Vegas, NV 89169',
    resort: 'The Venetian Resort, 3355 S Las Vegas Blvd, Las Vegas, NV 89109',
    caesars: 'Caesars Palace, 3570 S Las Vegas Blvd, Las Vegas, NV 89109'
  };

  const STREET = {
    expo: '201 Sands Ave, Las Vegas, NV 89169',
    resort: '3355 S Las Vegas Blvd, Las Vegas, NV 89109',
    caesars: '3570 S Las Vegas Blvd, Las Vegas, NV 89109'
  };

  const BUILDING = {
    expo: 'The Venetian Expo',
    resort: 'The Venetian Resort',
    caesars: 'Caesars Palace'
  };

  const GROUPS = [
    { id: 'main-stages', label: 'Main Stages' },
    { id: 'summits', label: 'Summits' },
    { id: 'moneypot', label: 'MoneyPot' },
    { id: 'intersection', label: 'The Intersection' },
    { id: 'startup', label: 'Startup' },
    { id: 'evening', label: 'Evening & Off-site' },
    { id: 'other', label: 'Other' }
  ];

  const EXPO = 'https://money2020usa26.expofp.com/?';
  const MONEYPOT_MAP = EXPO + 'money-pot-or-4097';
  const CASANOVA_MAP = EXPO + 'cybersecurity-summit-am-%2F-blockchain-summit-pm%2C-powered-by-uphold-or-casanova-501-604';
  const BALLROOM_LEVEL = 'Level 1'; // Galileo / Marco Polo / Casanova ballrooms (see SOURCES)

  // site: expo | resort | caesars. offsite = not inside The Venetian Expo.
  const VENUES = [
    { venue: 'Meridian Stage', room: 'Meridian Stage', area: '', site: 'expo', group: 'main-stages',
      mapUrl: EXPO + 'meridian-stage-or-9046' },
    { venue: 'Exchange Stage', room: 'Exchange Stage', area: '', site: 'expo', group: 'main-stages',
      mapUrl: EXPO + 'exchange-stage-or-21001' },
    { venue: 'ArrA.I.val Stage', room: 'ArrA.I.val Stage', area: '', site: 'expo', group: 'main-stages',
      mapUrl: EXPO + 'arraival-stage-or-12017' },
    { venue: 'Master Track Deep Dive', room: 'Master Track Deep Dive', area: '', site: 'expo', group: 'main-stages',
      mapUrl: EXPO + 'master-track-deep-dive-or-1060' },

    { venue: 'Intelligence Summit: Galileo 1001-1003', room: 'Galileo 1001-1003', area: 'Intelligence Summit',
      site: 'expo', group: 'summits', level: BALLROOM_LEVEL,
      mapUrl: EXPO + 'intelligence-summit-or-galileo-901-1003' },
    { venue: 'Network Effects Summit: Marco Polo 801-803', room: 'Marco Polo 801-803', area: 'Network Effects Summit',
      site: 'expo', group: 'summits', level: BALLROOM_LEVEL,
      mapUrl: EXPO + 'network-effects-summit-or-marco-polo-701-803' },
    { venue: 'Family Office & WealthTech Summit: Marco Polo 705-707', room: 'Marco Polo 705-707',
      area: 'Family Office & WealthTech Summit', site: 'expo', group: 'summits', level: BALLROOM_LEVEL,
      mapUrl: EXPO + 'family-office-and-wealthtech-summit-or-marco-polo-705-807' },
    { venue: 'Cybersecurity Summit: Casanova 501-504', room: 'Casanova 501-504', area: 'Cybersecurity Summit',
      site: 'expo', group: 'summits', level: BALLROOM_LEVEL, mapUrl: CASANOVA_MAP },
    { venue: 'Blockchain Summit, Powered by Uphold: Casanova 501-504', room: 'Casanova 501-504',
      area: 'Blockchain Summit, Powered by Uphold', site: 'expo', group: 'summits', level: BALLROOM_LEVEL,
      mapUrl: CASANOVA_MAP },

    { venue: 'MoneyPot Stage', room: 'MoneyPot Stage', area: 'MoneyPot', site: 'expo', group: 'moneypot',
      mapUrl: MONEYPOT_MAP },
    { venue: 'MoneyPot Podcast Booth 1', room: 'Podcast Booth 1', area: 'MoneyPot', site: 'expo', group: 'moneypot',
      mapUrl: MONEYPOT_MAP },
    { venue: 'MoneyPot Podcast Booth 2', room: 'Podcast Booth 2', area: 'MoneyPot', site: 'expo', group: 'moneypot',
      mapUrl: MONEYPOT_MAP },
    { venue: 'MoneyPot Bar', room: 'MoneyPot Bar', area: 'MoneyPot', site: 'expo', group: 'moneypot',
      mapUrl: MONEYPOT_MAP },

    { venue: 'The Intersection Stage', room: 'The Intersection Stage', area: 'The Intersection', site: 'expo',
      group: 'intersection', mapUrl: EXPO + 'the-intersection-stage-or-17116' },
    { venue: 'Meetups at The Intersection', room: 'Meetups', area: 'The Intersection', site: 'expo',
      group: 'intersection', mapUrl: EXPO + 'meetups-at-the-intersection-or-11133' },
    { venue: 'Coffee Corner at The Intersection', room: 'Coffee Corner', area: 'The Intersection', site: 'expo',
      group: 'intersection', mapUrl: EXPO + 'intersection-coffee-corner-or-15130' },

    { venue: 'Startup Stage', room: 'Startup Stage', area: 'Startup Hub', site: 'expo', group: 'startup',
      mapUrl: EXPO + 'startup-hub-powered-by-first-citizens-innovation-banking-or-23095' },

    { venue: 'Money Row', room: 'Money Row', area: 'Restaurant Row', site: 'resort', group: 'evening',
      mapUrl: EXPO + 'sugarcane-raw-bar-grill' },
    { venue: 'Chica @ The Venetian', room: 'Chica', area: '', site: 'resort', group: 'evening',
      mapUrl: EXPO + 'chica' },
    { venue: 'Yardbird @ The Venetian', room: 'Yardbird', area: '', site: 'resort', group: 'evening',
      mapUrl: EXPO + 'yardbird' },
    { venue: 'OMNIA Nightclub, Caesars Palace', room: 'OMNIA Nightclub', area: '', site: 'caesars', group: 'evening',
      mapUrl: 'https://maps.app.goo.gl/TFDpwKSDen8GjUEJ9' },

    { venue: 'Closed Door Roundtable', room: 'Closed Door Roundtable', area: '', site: 'expo', group: 'other',
      mapUrl: null, note: 'Room shared with registered participants' }
  ];

  function norm(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/@/g, ' at ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|and|at)\b/g, ' ')
      .replace(/\s+/g, '')
      .trim();
  }

  function mapsSearch(query) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
  }

  function groupLabel(id) {
    for (let i = 0; i < GROUPS.length; i += 1) {
      if (GROUPS[i].id === id) {
        return GROUPS[i].label;
      }
    }
    return 'Other';
  }

  function build(def, originalName) {
    const site = def.site || 'expo';
    const building = BUILDING[site];
    const address = ADDRESSES[site];
    const parts = [];
    if (def.room) {
      parts.push(def.room);
    }
    if (def.area && def.area !== def.room) {
      parts.push(def.area);
    }
    // ADDRESSES already starts with the building name.
    parts.push(address);
    // Google Maps query: building + street (room names confuse geocoding).
    const mapsQuery = building + ', ' + STREET[site];
    return {
      venue: originalName,
      room: def.room || '',
      area: def.area || '',
      building: building,
      level: def.level || '',
      address: address,
      offsite: site !== 'expo',
      mapUrl: def.mapUrl || null,
      mapsUrl: mapsSearch(mapsQuery),
      group: def.group || 'other',
      groupLabel: groupLabel(def.group || 'other'),
      location: parts.join(', '),
      note: def.note || '',
      known: def.known !== false
    };
  }

  const INDEX = {};
  VENUES.forEach(function (def) {
    INDEX[norm(def.venue)] = def;
  });

  // Best-effort parse for venues not in the table (e.g. a new summit room added after this file was written).
  function fallback(name) {
    const trimmed = name.trim();
    let room = trimmed;
    let area = '';
    const colon = trimmed.lastIndexOf(':');
    if (colon > 0 && colon < trimmed.length - 1) {
      area = trimmed.slice(0, colon).trim();
      room = trimmed.slice(colon + 1).trim();
    }
    let group = 'other';
    let site = 'expo';
    if (/summit/i.test(area)) {
      group = 'summits';
    } else if (/moneypot/i.test(trimmed)) {
      group = 'moneypot';
    } else if (/intersection/i.test(trimmed)) {
      group = 'intersection';
    } else if (/startup/i.test(trimmed)) {
      group = 'startup';
    } else if (/caesars/i.test(trimmed)) {
      group = 'evening';
      site = 'caesars';
    } else if (/@\s*the venetian|venetian resort/i.test(trimmed)) {
      group = 'evening';
      site = 'resort';
    } else if (/stage$/i.test(trimmed)) {
      group = 'main-stages';
    }
    return build({ room: room, area: area, site: site, group: group, mapUrl: null, known: false }, trimmed);
  }

  function resolve(venueName) {
    try {
      const name = typeof venueName === 'string' ? venueName : (venueName == null ? '' : String(venueName));
      const key = norm(name);
      if (key && Object.prototype.hasOwnProperty.call(INDEX, key)) {
        return build(INDEX[key], name.trim());
      }
      if (!key) {
        return build({ room: '', area: '', site: 'expo', group: 'other', mapUrl: null, known: false }, '');
      }
      return fallback(name);
    } catch (err) {
      return build({ room: '', area: '', site: 'expo', group: 'other', mapUrl: null, known: false }, '');
    }
  }

  function list() {
    const order = {};
    GROUPS.forEach(function (g, i) {
      order[g.id] = i;
    });
    return VENUES
      .map(function (def, i) {
        return { def: def, i: i };
      })
      .sort(function (a, b) {
        return (order[a.def.group] - order[b.def.group]) || (a.i - b.i);
      })
      .map(function (x) {
        return build(x.def, x.def.venue);
      });
  }

  function groups() {
    return GROUPS.map(function (g) {
      return {
        id: g.id,
        label: g.label,
        venues: VENUES.filter(function (v) {
          return v.group === g.id;
        }).map(function (v) {
          return v.venue;
        })
      };
    });
  }

  function groupOf(venueName) {
    return resolve(venueName).group;
  }

  return {
    resolve: resolve,
    list: list,
    groups: groups,
    groupOf: groupOf,
    normalize: norm,
    GROUPS: GROUPS.map(function (g) {
      return { id: g.id, label: g.label };
    }),
    ADDRESSES: ADDRESSES
  };
}));
