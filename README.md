# AQI Update Tool
air-quality-project/
├── package.json
├── server.js         # Express app, session/auth, minimal routes, node-cron
├── db.js             # Postgres connection & schema
├── scraping.js       # Puppeteer scraping logic (all requested sites)
├── auth.js           # Passport strategies: local, google, apple
├── views/
│   ├── index.html
│   ├── signup.html
│   ├── login.html
│   ├── donation.html
│   ├── forgot.html
│   └── reset.html
└── README.md         # (optional)
