# Event Swiper 📅

Tinder-style app to quickly select the events you want to go to for Money 2020.

After the 200+ events you get the calendar invites to just the ones you want to go to with all the details. 

RUNS LOCALLY ON BROWSER - NO DATA SENT TO SERVERS

See a deployed version here: [https://m2020.pages.dev](https://m2020.pages.dev)

## Features

- 📱 **Swipe Interface**: Swipe left to skip, right to save events
- ⌨️ **Keyboard Navigation**: Use arrow keys (← skip, → save) on desktop
- 💾 **Export**: Save selected events to JSON file
- 🔄 **Reset**: Start over if needed
- 📊 **Event Details**: See full event info including speakers, time, venue, and topics

## Usage

You can open `index.html` directly in a browser

- **Swipe right** or press **→** to save an event
- **Swipe left** or press **←** to skip an event
- Use the on-screen buttons if you prefer

## How It Works

- Events and speaker data are fetched from the official Money 2020 event endpoints 
- Selections persist in `localStorage`, so refreshing the page keeps your data and the data is only ever stored on your computer.
- Export creates a timestamped JSON file in the browser using `Blob`
- You then get an .ics file to import to your calendar with all the events. 

## Tips

- Click **Refresh Events** to trigger a new fetch without reloading the page
- Use **View Selected**, **Reset All**, and **Export** to manage your shortlist at any time
