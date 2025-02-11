# AQI Update Tool

```plaintext
air-quality-project/
├── package.json
├── server.js            # Main Express app
├── db.js                # Postgres connection & schema
├── auth.js              # Passport strategies (local, Google, Apple)
├── weather.js           # OpenWeather, AirNow, wind logic
├── scraping.js          # Scraping logic (fire.airnow, xappp, arcgis)
├── utils.js             # distanceMiles, color-coded AQI, etc.
├── views/
│   ├── index.html
│   ├── signup.html
│   ├── login.html
│   ├── donation.html
│   ├── forgot.html
│   ├── reset.html
│   ├── dashboard.html
└── README.md

```
TO DO:
1) Web scraping from https://fire.airnow.gov/#10/34.1124/-118.1932 to parse lat/lon (example only)
2) Caveat: This is a large example. Certain parts—like the scraping from fire.airnow.gov—are partially mocked or approximate because that site’s data is heavily JavaScript-based and subject to change. We demonstrate how you might parse lat/lon from the URL, but realistically you’d also scrape or parse smoke plumes from the map’s layers if available.
3) Real wind direction “bearing” logic would require more detailed trigonometry. This is a placeholder to illustrate color-coded logic.
4) scraping: arcgis or other sites omitted for brevity. Similar approach if needed.
5) Add Google and Apple to Signup.
