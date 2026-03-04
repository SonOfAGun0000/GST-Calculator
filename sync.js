import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
  import { getDatabase, ref, set, onValue, runTransaction, get } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

  const firebaseConfig = {
    apiKey: "AIzaSyA4NGdwbvS0JPR3jEpYXYIzlVFs9v3HEKQ",
    authDomain: "gst-quote-by-sathish-sekar.firebaseapp.com",
    databaseURL: "https://gst-quote-by-sathish-sekar-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "gst-quote-by-sathish-sekar",
    storageBucket: "gst-quote-by-sathish-sekar.firebasestorage.app",
    messagingSenderId: "1031085607122",
    appId: "1:1031085607122:web:8b12cf7f19ce834760850b",
    measurementId: "G-BS0VBLHRXB"
  };

  const app = initializeApp(firebaseConfig);
  const database = getDatabase(app);


// expose globally
window.database = database;
window.ref = ref;
window.set = set;
window.onValue = onValue;
window.runTransaction = runTransaction;
window.get = get;
window.dispatchEvent(new Event("firebase-ready"));

