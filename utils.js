// utils.js

// Compute miles between lat/lon pairs
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const R=3958.8; // radius in miles
  const dLat=(lat2-lat1)*(Math.PI/180);
  const dLon=(lon2-lon1)*(Math.PI/180);
  const a=Math.sin(dLat/2)**2
          +Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  return R*c;
}

// Convert numeric AQI to textual category
export function colorCodeAQI(aqi){
  const val=Number(aqi)||0;
  if(val<=50) return 'Good';
  if(val<=100) return 'Moderate';
  if(val<=150) return 'Unhealthy for Sensitive Groups';
  if(val<=200) return 'Unhealthy';
  if(val<=300) return 'Very Unhealthy';
  return 'Hazardous';
}

// Return inline style for color-coded text
export function getAQIColorStyle(aqi){
  const val=Number(aqi)||0;
  let color='#000';
  if(val<=50) color='#009966';
  else if(val<=100) color='#ffde33';
  else if(val<=150) color='#ff9933';
  else if(val<=200) color='#cc0033';
  else if(val<=300) color='#660099';
  else color='#7e0023';
  return `color:${color}; font-weight:bold;`;
}

// Official pm2.5 -> AQI
const PM25_BREAKPOINTS=[
  { pmLow:0.0,    pmHigh:12.0,   aqiLow:0,   aqiHigh:50 },
  { pmLow:12.1,   pmHigh:35.4,   aqiLow:51,  aqiHigh:100},
  { pmLow:35.5,   pmHigh:55.4,   aqiLow:101, aqiHigh:150},
  { pmLow:55.5,   pmHigh:150.4,  aqiLow:151, aqiHigh:200},
  { pmLow:150.5,  pmHigh:250.4,  aqiLow:201, aqiHigh:300},
  { pmLow:250.5,  pmHigh:500.4,  aqiLow:301, aqiHigh:500}
];

export function pm25toAQI(pm){
  let x=pm;
  if(x<0) x=0;
  if(x>500.4) return 500; // clamp
  for(const bp of PM25_BREAKPOINTS){
    if(x>=bp.pmLow && x<=bp.pmHigh){
      const ratio=(x-bp.pmLow)/(bp.pmHigh-bp.pmLow);
      const range=(bp.aqiHigh-bp.aqiLow);
      return Math.round(bp.aqiLow + ratio*range);
    }
  }
  return 0;
}

// For times, we want "Today at 2:00pm" or "Tomorrow at 8:15am"
export function formatUserTime(dateObj){
  // dateObj = a JS Date
  const now=new Date();
  const isSameDay = (now.toDateString()===dateObj.toDateString());
  let dayLabel = isSameDay ? 'Today' : 'Tomorrow';
  // If date is after more than 1 day, you can adapt further, e.g. day after tomorrow, etc.
  // We'll keep it simple

  const hours24=dateObj.getHours();
  const ampm= hours24>=12 ? 'pm':'am';
  let hr= hours24%12;
  if(hr===0) hr=12;
  const mins=dateObj.getMinutes();
  const mm= mins<10 ? '0'+mins : ''+mins;
  return `${dayLabel} at ${hr}:${mm}${ampm}`;
}
