# AQI Update Tool

```plaintext
air-quality-project/
├── package.json
├── server.js            # Express, routes, user dashboard
├── db.js                # Postgres connection & schema
├── auth.js              # Passport strategies (local, Google, Apple)
├── scraping.js          # Web scraping logic (fire.airnow.gov, xappp, arcgis, etc.)
├── weather.js           # OpenWeather, AirNow, wind direction logic
├── utils.js             # distanceMiles, parseAirNowFireUrl, color-coded logic, etc.
├── views/
│   ├── index.html
│   ├── signup.html
│   ├── login.html
│   ├── donation.html
│   ├── forgot.html
│   ├── reset.html
│   └── dashboard.html   # new page for user's most recent report
└── README.md 

```
TO DO:
1) Web scraping from https://fire.airnow.gov/#10/34.1124/-118.1932 to parse lat/lon (example only)
2) Caveat: This is a large example. Certain parts—like the scraping from fire.airnow.gov—are partially mocked or approximate because that site’s data is heavily JavaScript-based and subject to change. We demonstrate how you might parse lat/lon from the URL, but realistically you’d also scrape or parse smoke plumes from the map’s layers if available.
3) Real wind direction “bearing” logic would require more detailed trigonometry. This is a placeholder to illustrate color-coded logic.
