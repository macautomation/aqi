// utils.js
export function distanceMiles(lat1, lon1, lat2, lon2) {
  // Implementation from before
  const R = 3958.8; // radius in miles
  const dLat = (lat2 - lat1) * Math.PI/180;
  const dLon = (lon2 - lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

// We can return text categories or a color. Let's do category text:
export function colorCodeAQI(aqi) {
  if (!aqi || isNaN(aqi)) return 'Unknown';
  const val = parseInt(aqi, 10);
  if (val <= 50) return 'Good';
  if (val <= 100) return 'Moderate';
  if (val <= 150) return 'Unhealthy for Sensitive Groups';
  if (val <= 200) return 'Unhealthy';
  if (val <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}

// Return inline style for coloring text based on standard AQI category
export function getAQIColorStyle(aqi){
  let color='#000'; // default black
  const val = parseInt(aqi, 10);
  if (val <= 50) color='#009966'; 
  else if (val <= 100) color='#ffde33';
  else if (val <= 150) color='#ff9933';
  else if (val <= 200) color='#cc0033';
  else if (val <= 300) color='#660099';
  else color='#7e0023';
  return `color:${color}; font-weight:bold;`;
}

// PM2.5 Breakpoints for AQI
const PM25_BREAKPOINTS = [
  { pmLow: 0.0, pmHigh: 12.0, aqiLow: 0,   aqiHigh: 50  },
  { pmLow: 12.1, pmHigh: 35.4, aqiLow: 51,  aqiHigh: 100 },
  { pmLow: 35.5, pmHigh: 55.4, aqiLow: 101, aqiHigh: 150 },
  { pmLow: 55.5, pmHigh: 150.4,aqiLow: 151, aqiHigh: 200 },
  { pmLow: 150.5,pmHigh: 250.4,aqiLow: 201, aqiHigh: 300 },
  { pmLow: 250.5,pmHigh: 500.4,aqiLow: 301, aqiHigh: 500 }
];

export function pm25toAQI(pm) {
  if(pm < 0) pm=0;
  // If >500.4, we clamp to 500 for now
  if(pm>500.4) return 500; 
  for(const bp of PM25_BREAKPOINTS){
    if(pm>=bp.pmLow && pm<=bp.pmHigh){
      // linear interpolation
      const ratio = (pm - bp.pmLow)/(bp.pmHigh - bp.pmLow);
      const aqiRange = (bp.aqiHigh - bp.aqiLow);
      const aqi = bp.aqiLow + ratio * aqiRange;
      return Math.round(aqi);
    }
  }
  return 0; // fallback if something's odd
}
