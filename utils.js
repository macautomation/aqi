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
