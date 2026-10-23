// ====================================================================
// TRIP_LOGIC.JS - SISTEM OPERASIONAL PENGIRIMAN, DRIVER PORTAL & REKAP INSENTIF
// PT Cita Benggala Lestari (CBL Connect)
// Versi: 2.0 (Driver-Led, Multi-Hop GPS Estafet & Solusi A Toples Jarak)
// ====================================================================

// 1. Konstanta Utama
const LAT_GUDANG_CBL = -6.80173;
const LNG_GUDANG_CBL = 107.61377;
const KAPASITAS_PICKUP_NORMAL = 1500; // Kg
const UANG_SOLAR_TRUK_PER_TITIK = 100000; // Rp / Titik
const TARIF_INSENTIF_TOTAL_PICKUP = 15; // Rp / Kg Flat (dibagi rata ke kru pengiriman di trip tersebut)
const TARIF_MUAT_BONGKAR_TRUK = 15; // Rp / Kg Bersih Kru Muat
const TARIF_BONGKAR_MASUK_SUPPLIER = 15; // Rp / Kg

// State Global Modul Pengiriman & Driver
window.tripState = {
    cachedUsers: [],
    cachedRelasiMap: {},
    cachedUnassignedTx: [],
    cachedTrips: [],
    activePeriod: 'hari_ini', // 'hari_ini', 'minggu_ini', 'bulan_ini', 'custom'
    customStartDate: '',
    customEndDate: '',
    
    // State Khusus Driver / Kernek
    currentArmada: 'D 8070 UE',
    selectedKernekId: null,
    currentLegOrigin: null, // { lat, lng, namaTitik }
    activeTripItem: null,   // Trip yang sedang berjalan
    selectedPartialKg: {}   // Menyimpan input bawa sebagian { [relasi]: qty }
};

// ====================================================================
// 2. KALKULASI JARAK RUTE JALAN (OSRM ROUTING & HAVERSINE FALLBACK)
// ====================================================================

// Cache memori rute OSRM agar tidak berulang kali hit API untuk koordinat yang sama
window._osrmRouteCache = window._osrmRouteCache || {};

// Hitung Jarak Garis Lurus (Haversine) dalam Km
function hitungHaversineKm(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Hitung Estimasi Jarak Jalan Realistis (dengan faktor kelok pegunungan Lembang 2.5x dari garis lurus)
function hitungEstimasiJarakRealistis(lat1, lon1, lat2, lon2) {
    let haversine = hitungHaversineKm(lat1, lon1, lat2, lon2);
    let estimasi = haversine * 2.5;
    return Math.round(estimasi * 10) / 10;
}

// Ambil Jarak Riil Jalan Raya & Estimasi Durasi Perjalanan via OSRM (Open Source Routing Machine)
async function fetchJarakDanWaktuRiil(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) {
        return { km: 0, menit: 0, via: 'fallback' };
    }
    let cacheKey = `${Number(lat1).toFixed(5)},${Number(lon1).toFixed(5)};${Number(lat2).toFixed(5)},${Number(lon2).toFixed(5)}`;
    if (window._osrmRouteCache[cacheKey]) {
        return window._osrmRouteCache[cacheKey];
    }

    try {
        let url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
        let res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (res.ok) {
            let data = await res.json();
            if (data.routes && data.routes[0]) {
                let meter = data.routes[0].distance || 0;
                let detik = data.routes[0].duration || 0;
                let km = Math.round((meter / 1000) * 10) / 10;
                // Kecepatan pikap bermuatan di pegunungan Lembang: durasi OSRM + buffer 20%
                let menit = Math.max(5, Math.round((detik / 60) * 1.2));
                let result = { km, menit, via: 'osrm' };
                window._osrmRouteCache[cacheKey] = result;
                return result;
            }
        }
    } catch (e) {
        console.warn("OSRM routing offline/gagal, fallback ke estimasi jalan pegunungan:", e);
    }

    // Fallback realistis jika OSRM sedang lambat / offline
    let km = hitungEstimasiJarakRealistis(lat1, lon1, lat2, lon2);
    let menit = Math.max(5, Math.round(km * 4.5)); // ~15 km/jam di tanjakan/jalur sempit Lembang
    let result = { km, menit, via: 'fallback' };
    window._osrmRouteCache[cacheKey] = result;
    return result;
}

// Ambil Koordinat GPS HP Terkini
function getCurrentGpsPosition() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve({ lat: LAT_GUDANG_CBL, lng: LNG_GUDANG_CBL, isFallback: true });
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    isFallback: false
                });
            },
            (err) => {
                console.warn("GPS gagal, fallback ke koordinat Gudang CBL:", err.message);
                resolve({ lat: LAT_GUDANG_CBL, lng: LNG_GUDANG_CBL, isFallback: true });
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    });
}

// Progressive Geotagging: Kunci koordinat kandang peternak jika belum ada
async function autoLockTitikKandang(namaRelasi, lat, lng) {
    if (!namaRelasi || !lat || !lng) return;
    let rData = window.tripState.cachedRelasiMap[namaRelasi];
    if (rData && (!rData.lat || parseFloat(rData.lat) === 0)) {
        try {
            let jarakPP = Math.round(hitungEstimasiJarakRealistis(LAT_GUDANG_CBL, LNG_GUDANG_CBL, lat, lng) * 2 * 10) / 10;
            await fetch(`${SUPA_URL}/rest/v1/master_relasi?nama=eq.${encodeURIComponent(namaRelasi)}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal',
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                },
                body: JSON.stringify({ lat: lat, lng: lng, jarak_pp_km: jarakPP })
            });
            // Update cache lokal
            if (window.tripState.cachedRelasiMap[namaRelasi]) {
                window.tripState.cachedRelasiMap[namaRelasi].lat = lat;
                window.tripState.cachedRelasiMap[namaRelasi].lng = lng;
                window.tripState.cachedRelasiMap[namaRelasi].jarak_pp_km = jarakPP;
            }
            console.log(`✅ Geotagging otomatis tersimpan untuk ${namaRelasi}`);
        } catch (e) {
            console.warn("Gagal auto-lock geotagging:", e);
        }
    }
}

// ====================================================================
// 3. AMBIL DATA DARI SUPABASE (DATA MASTER & TRANSAKSI)
// ====================================================================

async function loadMasterDataTrip() {
    try {
        let [resUsers, resRelasi] = await Promise.all([
            fetch(`${SUPA_URL}/rest/v1/users_app?select=*&order=nama.asc`, {
                headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
            }),
            fetch(`${SUPA_URL}/rest/v1/master_relasi?select=*`, {
                headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
            })
        ]);

        if (resUsers.ok) {
            window.tripState.cachedUsers = await resUsers.json();
        }
        if (resRelasi.ok) {
            let relasiArr = await resRelasi.json();
            let rMap = {};
            relasiArr.forEach(r => { rMap[r.nama] = r; });
            window.tripState.cachedRelasiMap = rMap;
        }
    } catch (e) {
        console.error("Gagal load master data:", e);
    }
}

// Ambil Seluruh DO Pengiriman Hari Ini yang Belum Selesai Terkirim
async function fetchAntreanDOPengiriman(tanggalPilihan) {
    let tgl = tanggalPilihan || new Date().toISOString().split('T')[0];
    try {
        let [resTx, resTripsToday] = await Promise.all([
            fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=eq.${tgl}&status=ilike.%25keluar%25&order=waktu_input.asc`, {
                headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
            }),
            fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=eq.${tgl}`, {
                headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
            })
        ]);

        let allTx = resTx.ok ? await resTx.json() : [];
        let tripsToday = resTripsToday.ok ? await resTripsToday.json() : [];

        // 1. Kumpulkan relasi/order yang memiliki Ongkir Pengiriman aktif pada hari ini
        let relasiDenganOngkir = new Set();
        allTx.forEach(tx => {
            if (tx.pakan === 'Ongkir Pengiriman' && (parseFloat(tx.harga_satuan) > 0 || parseFloat(tx.qty) > 0)) {
                if (tx.relasi) relasiDenganOngkir.add(tx.relasi.trim().toLowerCase());
            }
        });

        // 2. Hitung Qty yang sudah termuat di trip-trip hari ini per relasi & per transaksi
        let terangkutMap = {}; // key: tx.id -> kg_sudah_angkut
        tripsToday.forEach(tr => {
            let items = Array.isArray(tr.manifest_items) ? tr.manifest_items : [];
            items.forEach(it => {
                if (it.tx_id) {
                    terangkutMap[it.tx_id] = (terangkutMap[it.tx_id] || 0) + (parseFloat(it.qty) || 0);
                }
            });
        });

        // 3. Saring hanya pakan yang MEMILIKI ONGKIR PENGIRIMAN & masih ada sisa
        let pendingTx = [];
        allTx.forEach(tx => {
            // Jangan masukkan baris ongkir itu sendiri ke dalam barang muat
            if (tx.pakan === 'Ongkir Pengiriman') return;

            let relasiClean = (tx.relasi || '').trim().toLowerCase();
            let catClean = (tx.catatan || '').toLowerCase();
            let hashStr = tx.hash_str || '';

            // 🔥 ABAIKAN JIKA TIDAK ADA ONGKIR PENGIRIMAN (Konsumen ambil sendiri, ambil motor, dll)
            let adaOngkirDiHash = /_ONGKIR:[1-9]/.test(hashStr);
            let punyaOngkirHariIni = relasiDenganOngkir.has(relasiClean) || adaOngkirDiHash;
            if (!punyaOngkirHariIni) {
                return; // Lewati: Tidak ada ongkir pengiriman
            }

            // Abaikan jika catatan mengandung kata ambil / ambil sendiri
            if (catClean.includes('ambil') || catClean.includes('diambil')) {
                return;
            }

            // Abaikan pakan mutasi kandang internal sapi
            let isKandang = ['jantan', 'betina', 'dewasa', 'kapalang', 'pedet', 'isolasi', 'kandang'].some(k => relasiClean.includes(k));
            if (isKandang) return;

            let totalOrder = parseFloat(tx.qty) || 0;
            let sudahKirim = terangkutMap[tx.id] || 0;
            let sisa = totalOrder - sudahKirim;
            if (sisa > 0.05) { // Toleransi desimal
                let clone = Object.assign({}, tx);
                clone.sisa_qty = Math.round(sisa * 10) / 10;
                pendingTx.push(clone);
            }
        });

        window.tripState.cachedUnassignedTx = pendingTx;
        return pendingTx;
    } catch (e) {
        console.error("Gagal fetch antrean DO:", e);
        return [];
    }
}

// Ambil Trip Berdasarkan Periode (Untuk Rekap & Monitoring)
async function fetchTripsByDateRange(startDate, endDate) {
    try {
        let url = `${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,created_at.desc`;
        let res = await fetch(url, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (res.ok) {
            window.tripState.cachedTrips = await res.json();
            return window.tripState.cachedTrips;
        }
    } catch (e) {
        console.error("Gagal fetch trips:", e);
    }
    return [];
}

// ====================================================================
// 4. LOGIKA PERHITUNGAN INSENTIF (FLAT RP 15/KG DIBAGI RATA KRU TRIP)
// ====================================================================

/**
 * Menghitung rincian upah bersih untuk seluruh trip periode ini.
 * Model Flat: Rp 15 / kg muat.
 * - Pick-Up: Total Rp 15 / kg dibagi rata ke kru yang bertugas di trip tersebut:
 *   * Sopir + 1 Kernek = dibagi 2 (Rp 7.5 / kg per orang)
 *   * Sopir + 2 Kernek = dibagi 3 (Rp 5 / kg per orang)
 *   * Sopir Sendiri = 100% (Rp 15 / kg)
 * - Truk: Bersih Rp 15 / kg dibagi rata ke kru muat gudang + uang solar supir (Rp 100.000 / titik).
 * - Ambil Mandiri: Bersih Rp 15 / kg dibagi rata ke kru muat gudang.
 */
function hitungAkumulasiInsentifPeriode(trips = [], users = []) {
    let userMap = {};
    users.forEach(u => {
        userMap[u.id] = {
            id: u.id,
            nama: u.nama,
            role: u.role,
            totalKgMuat: 0,      // Kg yang dibantu muat di gudang (Ambil Mandiri / Truk)
            totalKgAntar: 0,     // Kg yang diantar langsung ke peternak (Pick-Up)
            totalKgAll: 0,       // Total beban fisik yang ditangani
            upahMuatGudang: 0,   // Rupiah dari bantu muat gudang (15/kg)
            upahAntarPickup: 0,  // Rupiah dari antar pengiriman pick-up (15/kg)
            upahMuatTotal: 0,    // Gabungan seluruh insentif muat & antar (15/kg)
            uangSolarTruk: 0,    // Uang solar khusus supir truk
            totalBersih: 0,      // Total bersih yang diterima
            totalKm: 0,
            tripCount: 0,
            // Backwards-compatible aliases
            totalKgKirim: 0,
            totalKgOtot: 0,
            upahKirim: 0,
            upahOtot: 0,
            upahMuatTruk: 0,
            subsidiJarak: 0
        };
    });

    let totalKmSemuaPickup = 0;

    trips.forEach(tr => {
        let isTruk = (tr.armada === 'Truk');
        let isAmbilMandiri = (tr.armada === 'Ambil Mandiri');
        let kg = parseFloat(tr.total_kg) || 0;
        let km = parseFloat(tr.jarak_tempuh_km) || 0;

        if (isTruk || isAmbilMandiri) {
            // 1. Truk / Ambil Mandiri: Aktivitas Bantu Muat Gudang (Flat Rp 15/kg Kru Muat)
            if (isTruk) {
                let titik = parseInt(tr.jumlah_titik) || 1;
                let solar = parseFloat(tr.uang_jalan_sopir) || (titik * UANG_SOLAR_TRUK_PER_TITIK);
                if (tr.sopir_user_id && userMap[tr.sopir_user_id]) {
                    userMap[tr.sopir_user_id].uangSolarTruk += solar;
                    userMap[tr.sopir_user_id].totalBersih += solar;
                    userMap[tr.sopir_user_id].tripCount += 1;
                }
            }

            let pekerjaIds = Array.isArray(tr.pekerja_muat_ids) ? tr.pekerja_muat_ids : [];
            let nKru = pekerjaIds.length;
            if (nKru > 0) {
                let totalUpahMuat = kg * TARIF_MUAT_BONGKAR_TRUK; // Rp 15 / kg
                let perOrang = Math.floor(totalUpahMuat / nKru);
                let sisa = totalUpahMuat - (perOrang * nKru);

                pekerjaIds.forEach((uid, idx) => {
                    if (userMap[uid]) {
                        let dapat = perOrang + (idx === nKru - 1 ? sisa : 0);
                        let porsiKg = Math.round(kg / nKru);

                        userMap[uid].totalKgMuat += porsiKg;
                        userMap[uid].totalKgAll += porsiKg;
                        userMap[uid].totalKgKirim += porsiKg;
                        userMap[uid].totalKgOtot += porsiKg;

                        userMap[uid].upahMuatGudang += dapat;
                        userMap[uid].upahMuatTotal += dapat;
                        userMap[uid].upahKirim += dapat;
                        userMap[uid].upahOtot += dapat;
                        userMap[uid].upahMuatTruk += dapat;

                        userMap[uid].totalBersih += dapat;
                        userMap[uid].tripCount += 1;
                    }
                });
            }
        } else {
            // 2. Pick-Up: Aktivitas Antar Pengiriman ke Peternak (Flat Rp 15/kg dibagi rata kru)
            let sopirId = tr.sopir_user_id;
            let k1Id = tr.kernek_1_user_id;
            let k2Id = tr.kernek_2_user_id;
            let hasK2 = !!k2Id;
            let hasK1 = !!k1Id;
            let nKru = hasK2 ? 3 : (hasK1 ? 2 : 1);

            totalKmSemuaPickup += km;

            let totalUpahTrip = Math.round(kg * TARIF_INSENTIF_TOTAL_PICKUP);
            let perKru = Math.floor(totalUpahTrip / nKru);
            let sisa = totalUpahTrip - (perKru * nKru);
            let porsiKg = Math.round(kg / nKru);

            if (sopirId && userMap[sopirId]) {
                userMap[sopirId].totalKgAntar += porsiKg;
                userMap[sopirId].totalKgAll += porsiKg;
                userMap[sopirId].totalKgKirim += porsiKg;
                userMap[sopirId].totalKgOtot += porsiKg;

                userMap[sopirId].upahAntarPickup += perKru;
                userMap[sopirId].upahMuatTotal += perKru;
                userMap[sopirId].upahKirim += perKru;
                userMap[sopirId].upahOtot += perKru;

                userMap[sopirId].totalKm += km;
                userMap[sopirId].totalBersih += perKru;
                userMap[sopirId].tripCount += 1;
            }
            if (k1Id && userMap[k1Id]) {
                userMap[k1Id].totalKgAntar += porsiKg;
                userMap[k1Id].totalKgAll += porsiKg;
                userMap[k1Id].totalKgKirim += porsiKg;
                userMap[k1Id].totalKgOtot += porsiKg;

                userMap[k1Id].upahAntarPickup += perKru;
                userMap[k1Id].upahMuatTotal += perKru;
                userMap[k1Id].upahKirim += perKru;
                userMap[k1Id].upahOtot += perKru;

                userMap[k1Id].totalKm += km;
                userMap[k1Id].totalBersih += perKru;
                userMap[k1Id].tripCount += 1;
            }
            if (k2Id && userMap[k2Id]) {
                let dapatK2 = perKru + sisa;
                userMap[k2Id].totalKgAntar += porsiKg;
                userMap[k2Id].totalKgAll += porsiKg;
                userMap[k2Id].totalKgKirim += porsiKg;
                userMap[k2Id].totalKgOtot += porsiKg;

                userMap[k2Id].upahAntarPickup += dapatK2;
                userMap[k2Id].upahMuatTotal += dapatK2;
                userMap[k2Id].upahKirim += dapatK2;
                userMap[k2Id].upahOtot += dapatK2;

                userMap[k2Id].totalKm += km;
                userMap[k2Id].totalBersih += dapatK2;
                userMap[k2Id].tripCount += 1;
            }
        }
    });

    let grandTotal = Object.values(userMap).reduce((acc, u) => acc + u.totalBersih, 0);

    return {
        userMap,
        totalKmSemuaPickup,
        grandTotal,
        totalToplesJarak: 0 // Tidak ada toples jarak
    };
}

// ====================================================================
// 5. PORTAL SUPIR & KERNEK (MOBILE INTERFACE LOGIC)
// ====================================================================

// Inisialisasi Layar Khusus Supir / Kernek saat Login
async function initDriverPortal() {
    await loadMasterDataTrip();

    // 1. Update Header Nama & Role Badge Dinamis Sesuai Akun Login
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    let myRole = (meUser?.role || (typeof currentRole !== 'undefined' ? currentRole : '') || 'sopir').toLowerCase();
    
    let elName = document.getElementById('driver-portal-user-name');
    let elBadge = document.getElementById('driver-portal-role-badge');
    if (elName) elName.innerText = `Halo, ${activeUser || 'Driver'}`;
    if (elBadge) {
        let roleDisplay = (myRole.includes('kernek')) ? 'Kernek' : (myRole.includes('sopir') ? 'Sopir' : 'Petugas');
        elBadge.innerText = roleDisplay;
    }

    // Role Kernek: Sembunyikan Log Armada (Khusus untuk Supir Penanggung Jawab Armada)
    let isKernekRole = myRole.includes('kernek');
    let navArmada = document.getElementById('nav-driver-armada');
    let btnArmadaTop = document.getElementById('btn-driver-log-armada-top');
    if (navArmada) {
        if (isKernekRole) navArmada.classList.add('hidden');
        else navArmada.classList.remove('hidden');
    }
    if (btnArmadaTop) {
        if (isKernekRole) btnArmadaTop.classList.add('hidden');
        else btnArmadaTop.classList.remove('hidden');
    }

    // Default Armada sesuai supir yang login: Adi -> D 8142 UK, Hilman -> D 8070 UE
    let myNameLower = (activeUser || '').toLowerCase();
    let armadaDesc = 'Grand Max Pick-up';
    if (myNameLower.includes('adi')) {
        window.tripState.currentArmada = 'D 8142 UK';
        armadaDesc = 'Pick-up Putih';
    } else if (myNameLower.includes('hilman')) {
        window.tripState.currentArmada = 'D 8070 UE';
        armadaDesc = 'Grand Max Pick-up';
    } else {
        window.tripState.currentArmada = 'D 8070 UE';
    }

    let elArmadaName = document.getElementById('driver-portal-armada-name');
    let elArmadaTag = document.getElementById('driver-portal-armada-tag');
    if (elArmadaName) {
        if (isKernekRole) {
            elArmadaName.innerText = window.tripState.currentArmada ? `${window.tripState.currentArmada} (Armada Terpilih)` : 'Pilih Sopir Armada di Bawah';
            if (elArmadaTag) elArmadaTag.innerText = 'Ikut Sopir';
        } else {
            elArmadaName.innerText = `${window.tripState.currentArmada} (${armadaDesc})`;
            if (elArmadaTag) elArmadaTag.innerText = 'Tetap';
        }
    }

    renderArmadaKernekPills();
    await loadDriverMonthlyStats();
    await refreshAntreanDriver();
    await loadDompetDriver();

    // Deteksi jika supir/kernek memiliki trip aktif yang sedang berjalan
    await cekTripAktifDriver();

    // Heartbeat auto-sync setiap 12 detik saat berada di portal driver
    if (!window._driverPortalInterval) {
        window._driverPortalInterval = setInterval(() => {
            let portalEl = document.getElementById('page-driver-portal');
            if (portalEl && !portalEl.classList.contains('hidden')) {
                cekTripAktifDriver();
            }
        }, 12000);
    }
}

let currentStatBulanMode = 'ini';

function switchFilterBulanDriver(mode) {
    currentStatBulanMode = mode;
    let btnIni = document.getElementById('btn-stat-bulan-ini');
    let btnLalu = document.getElementById('btn-stat-bulan-lalu');
    if (mode === 'ini') {
        if (btnIni) { btnIni.style.background = '#2563eb'; btnIni.style.color = '#ffffff'; btnIni.style.borderColor = '#2563eb'; }
        if (btnLalu) { btnLalu.style.background = '#ffffff'; btnLalu.style.color = '#475569'; btnLalu.style.borderColor = '#cbd5e1'; }
    } else {
        if (btnIni) { btnIni.style.background = '#ffffff'; btnIni.style.color = '#475569'; btnIni.style.borderColor = '#cbd5e1'; }
        if (btnLalu) { btnLalu.style.background = '#2563eb'; btnLalu.style.color = '#ffffff'; btnLalu.style.borderColor = '#2563eb'; }
    }
    loadDriverMonthlyStats(mode);
}

// Memuat Statistik Kinerja Bulanan Supir (Mendukung Filter Bulan Ini & Bulan Lalu)
async function loadDriverMonthlyStats(mode = currentStatBulanMode) {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) return;

    let now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth();

    let targetDate = (mode === 'lalu') ? new Date(year, month - 1, 1) : new Date(year, month, 1);
    let tYear = targetDate.getFullYear();
    let tMonth = targetDate.getMonth();
    let pad = n => String(n).padStart(2, '0');
    let firstDay = `${tYear}-${pad(tMonth + 1)}-01`;
    let lastDateObj = new Date(tYear, tMonth + 1, 0);
    let lastDay = `${tYear}-${pad(tMonth + 1)}-${pad(lastDateObj.getDate())}`;

    let monthName = targetDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    let elBulan = document.getElementById('driver-stat-bulan');
    if (elBulan) {
        elBulan.innerText = `${monthName} (${mode === 'lalu' ? 'Bulan Lalu' : 'Bulan Ini'})`;
    }

    try {
        let trips = await fetchTripsByDateRange(firstDay, lastDay);
        
        // Filter trip selesai yang melibatkan supir / kernek ini di bulan terpilih
        let myMonthlyTrips = trips.filter(tr => 
            (tr.status_trip === 'SELESAI') &&
            (tr.sopir_user_id === meUser.id || tr.kernek_1_user_id === meUser.id || tr.kernek_2_user_id === meUser.id || (tr.pekerja_muat_ids || []).includes(meUser.id))
        );

        // 1. Total Rit (Pengantaran perjalanan armada yang dijalankan kru)
        let ritTrips = myMonthlyTrips.filter(tr => 
            tr.armada !== 'Ambil Mandiri' && 
            (tr.sopir_user_id === meUser.id || tr.kernek_1_user_id === meUser.id || tr.kernek_2_user_id === meUser.id)
        );
        let totalRit = ritTrips.length;

        // 2. Total KM (Jarak tempuh rute pengantaran)
        let totalKm = ritTrips.reduce((s, tr) => s + (parseFloat(tr.jarak_tempuh_km) || 0), 0);

        // 3. Total Bongkar (Pakan yang diantar & dibongkar ke kandang peternak lewat Pick-Up)
        let totalKgBongkar = 0;

        // 4. Total Muat (Pakan yang dimuat di gudang lewat Bantu Muat Truk / Ambil Mandiri)
        let totalKgMuat = 0;

        myMonthlyTrips.forEach(tr => {
            let kg = parseFloat(tr.total_kg) || 0;
            let isTruk = (tr.armada === 'Truk');
            let isMandiri = (tr.armada === 'Ambil Mandiri');

            if (isTruk || isMandiri) {
                totalKgMuat += kg;
            } else {
                totalKgBongkar += kg;
            }
        });

        let nf = new Intl.NumberFormat('id-ID');
        let elRit = document.getElementById('driver-stat-rit');
        let elKm = document.getElementById('driver-stat-km');
        let elBongkar = document.getElementById('driver-stat-bongkar');
        let elMuat = document.getElementById('driver-stat-muat');
        let elKg = document.getElementById('driver-stat-kg');

        if (elRit) elRit.innerText = `${nf.format(totalRit)} Rit`;
        if (elKm) elKm.innerText = `${nf.format(totalKm)} Km`;
        if (elBongkar) elBongkar.innerText = `${nf.format(totalKgBongkar)} Kg`;
        if (elMuat) elMuat.innerText = `${nf.format(totalKgMuat)} Kg`;
        if (elKg) elKg.innerText = `${nf.format(totalKgBongkar)} Kg`;
    } catch (err) {
        console.warn("Gagal memuat statistik bulanan supir:", err);
    }
}

// Render Tombol Pill Pilihan Armada & Partner (Sopir / Kernek)
function renderArmadaKernekPills() {
    let users = window.tripState.cachedUsers || [];
    let partnerArea = document.getElementById('driver-partner-selection-area');
    let partnerContainer = document.getElementById('driver-kernek-chips');
    let partnerLabel = document.getElementById('label-pilih-partner');
    if (!partnerContainer && !partnerArea) return;

    let meUser = users.find(u => u.nama === activeUser);
    let myRole = (meUser?.role || (typeof currentRole !== 'undefined' ? currentRole : '') || 'sopir').toLowerCase();

    // Pastikan array selectedKernekIds tersedia
    if (!Array.isArray(window.tripState.selectedKernekIds)) {
        window.tripState.selectedKernekIds = window.tripState.selectedKernekId ? [window.tripState.selectedKernekId] : [];
    }

    // Sinkronkan styling pill armada aktif di DOM
    let curArmada = window.tripState.currentArmada || 'D 8070 UE';
    document.querySelectorAll('.btn-pill-armada').forEach(b => {
        let isSel = (b.dataset.armada === curArmada);
        b.style.background = isSel ? '#2563eb' : '#f1f5f9';
        b.style.color = isSel ? '#ffffff' : '#475569';
        b.style.borderColor = isSel ? '#1d4ed8' : '#cbd5e1';
    });

    if (myRole.includes('kernek')) {
        // JIKA LOGIN SEBAGAI KERNEK (misal: Enggeng / Mang Oboy):
        // 1. Pilih Sopir Armada (Wajib 1)
        // 2. Pilih Kernek Tambahan (Opsional 1 orang lain)
        let driverCandidates = users.filter(u => (u.role || '').toLowerCase().includes('sopir'));
        let otherKruCandidates = users.filter(u => {
            let r = (u.role || '').toLowerCase();
            let isKernek = r.includes('kernek') && !u.nama.includes('Petugas') && !u.nama.includes('Agus');
            return isKernek && u.nama !== activeUser;
        });

        let targetEl = partnerArea || partnerContainer;
        targetEl.innerHTML = `
            <div style="margin-bottom: 10px;">
                <span style="font-size: 11px; font-weight: 700; color: #1e293b; display: block; margin-bottom: 6px;">
                    Pilih Sopir Armada <span style="color:#dc2626; font-size:10px;">*Wajib</span>:
                </span>
                <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${driverCandidates.map(u => {
                        let isSelected = (window.tripState.selectedSopirId === u.id);
                        return `
                            <button type="button" onclick="selectPartnerChip(${u.id}, 'sopir')" class="btn-chip-partner ${isSelected ? 'active' : ''}" style="border:1px solid ${isSelected ? '#2563eb' : '#cbd5e1'}; background:${isSelected ? '#eff6ff' : '#ffffff'}; color:${isSelected ? '#1d4ed8' : '#334155'}; padding:6px 12px; border-radius:20px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:5px; margin:2px;">
                                <span class="material-symbols-outlined" style="font-size:14px; color:${isSelected ? '#2563eb' : '#64748b'};">${isSelected ? 'check_circle' : 'person'}</span> ${u.nama}
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>

            <div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                    <span style="font-size: 11px; font-weight: 700; color: #475569;">
                        Pilih Kernek Tambahan <span style="font-size:10px; color:#64748b; font-weight:normal;">(Opsional, jika berdua):</span>
                    </span>
                    ${window.tripState.selectedKernekIds.length > 0 ? `
                        <button type="button" onclick="resetKernekSelection()" style="background:none; border:none; color:#ef4444; font-size:10px; cursor:pointer; text-decoration:underline;">Hapus Tambahan</button>
                    ` : ''}
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${otherKruCandidates.map(u => {
                        let isSelected = window.tripState.selectedKernekIds.includes(u.id);
                        return `
                            <button type="button" onclick="selectPartnerChip(${u.id}, 'kernek_extra')" class="btn-chip-partner ${isSelected ? 'active' : ''}" style="border:1px solid ${isSelected ? '#16a34a' : '#cbd5e1'}; background:${isSelected ? '#f0fdf4' : '#ffffff'}; color:${isSelected ? '#15803d' : '#334155'}; padding:5px 10px; border-radius:20px; font-size:11px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:4px; margin:2px;">
                                <span class="material-symbols-outlined" style="font-size:14px; color:${isSelected ? '#16a34a' : '#64748b'};">${isSelected ? 'check_circle' : 'person_add'}</span> ${u.nama}
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    } else {
        // JIKA LOGIN SEBAGAI SOPIR (misal: Hilman / Adi):
        let kruCandidates = users.filter(u => {
            let r = (u.role || '').toLowerCase();
            let isKernek = r.includes('kernek') && !u.nama.includes('Petugas') && !u.nama.includes('Agus');
            return isKernek && u.nama !== activeUser;
        });

        let selectedCount = window.tripState.selectedKernekIds.length;
        let countBadge = selectedCount > 0 
            ? `<span style="background:#eff6ff; color:#2563eb; font-size:10px; font-weight:800; padding:1px 6px; border-radius:10px; margin-left:6px;">${selectedCount} Terpilih (Maks 2)</span>`
            : `<span style="font-size:10px; color:#64748b; font-weight:normal; margin-left:4px;">(Bisa pilih 1 atau 2 orang)</span>`;

        let targetEl = partnerArea || partnerContainer;
        targetEl.innerHTML = `
            <div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                    <span style="font-size: 11px; font-weight: 700; color: #1e293b;">
                        Pilih Kernek Pendamping: ${countBadge}
                    </span>
                    ${selectedCount > 0 ? `
                        <button type="button" onclick="resetKernekSelection()" style="background:none; border:none; color:#ef4444; font-size:10px; cursor:pointer; text-decoration:underline;">Reset</button>
                    ` : ''}
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${kruCandidates.map(u => {
                        let isSelected = window.tripState.selectedKernekIds.includes(u.id);
                        return `
                            <button type="button" onclick="selectPartnerChip(${u.id}, 'kernek')" class="btn-chip-partner ${isSelected ? 'active' : ''}" style="border:1px solid ${isSelected ? '#2563eb' : '#cbd5e1'}; background:${isSelected ? '#eff6ff' : '#ffffff'}; color:${isSelected ? '#1d4ed8' : '#334155'}; padding:6px 12px; border-radius:20px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:5px; margin:2px;">
                                <span class="material-symbols-outlined" style="font-size:14px; color:${isSelected ? '#2563eb' : '#64748b'};">${isSelected ? 'check_circle' : 'person_add'}</span> ${u.nama}
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }
}

function selectArmadaPill(armadaPlat) {
    window.tripState.currentArmada = armadaPlat;
    let desc = (armadaPlat === 'D 8142 UK') ? 'Pick-up Putih' : 'Grand Max Pick-up';
    let elArmadaName = document.getElementById('driver-portal-armada-name');
    if (elArmadaName) {
        elArmadaName.innerText = `${armadaPlat} (${desc})`;
    }
    document.querySelectorAll('.btn-pill-armada').forEach(b => {
        let isSel = (b.dataset.armada === armadaPlat);
        b.style.background = isSel ? '#2563eb' : '#f1f5f9';
        b.style.color = isSel ? '#ffffff' : '#475569';
        b.style.borderColor = isSel ? '#1d4ed8' : '#cbd5e1';
    });
    refreshAntreanDriver();
}

function getActiveTripKruCount() {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    let myRole = (meUser?.role || (typeof currentRole !== 'undefined' ? currentRole : '') || 'sopir').toLowerCase();
    let isKernek = myRole.includes('kernek');

    let extraCount = Array.isArray(window.tripState.selectedKernekIds) ? window.tripState.selectedKernekIds.length : 0;
    if (isKernek) {
        // Kernek sendiri + sopir armada (wajib 1) + kernek extra (jika ada)
        return 2 + extraCount;
    } else {
        // Sopir sendiri + jumlah kernek pendamping yang dipilih (0, 1, atau 2)
        return 1 + extraCount;
    }
}

function updateEstimasiUpahSemuaCards() {
    let nKru = getActiveTripKruCount();
    let nf = new Intl.NumberFormat('id-ID');
    let kruLabel = (nKru === 1) ? 'Solo' : `Bagi ${nKru}`;

    // Update semua kartu order yang ada di DOM secara dinamis
    let buttons = document.querySelectorAll('[id^="btn-antar-"]');
    if (buttons.length > 0) {
        buttons.forEach(btnAntar => {
            btnAntar.dataset.kru = nKru;
            let safeKey = btnAntar.id.replace('btn-antar-', '');
            let kruLabelEl = document.getElementById(`kru-label-${safeKey}`);
            if (kruLabelEl) {
                kruLabelEl.innerText = `(${kruLabel})`;
            }
            hitungTotalBawaRelasi(safeKey);
        });
    } else {
        let relGroups = window.tripState.driverRelasiGroups || {};
        Object.keys(relGroups).forEach((_, idx) => {
            let safeKey = 'rel_' + idx;
            let btnAntar = document.getElementById(`btn-antar-${safeKey}`);
            if (btnAntar) btnAntar.dataset.kru = nKru;
            let kruLabelEl = document.getElementById(`kru-label-${safeKey}`);
            if (kruLabelEl) kruLabelEl.innerText = `(${kruLabel})`;
            hitungTotalBawaRelasi(safeKey);
        });
    }
}

function selectPartnerChip(userId, type) {
    if (!Array.isArray(window.tripState.selectedKernekIds)) {
        window.tripState.selectedKernekIds = [];
    }

    if (type === 'sopir') {
        if (window.tripState.selectedSopirId === userId) {
            window.tripState.selectedSopirId = null;
        } else {
            window.tripState.selectedSopirId = userId;
            // Jika kernek memilih supir Adi -> Armada otomatis D 8142 UK
            // Jika kernek memilih supir Hilman -> Armada otomatis D 8070 UE
            let selUser = (window.tripState.cachedUsers || []).find(u => u.id === userId);
            if (selUser) {
                let sName = (selUser.nama || '').toLowerCase();
                if (sName.includes('adi')) selectArmadaPill('D 8142 UK');
                else if (sName.includes('hilman')) selectArmadaPill('D 8070 UE');
            }
        }
    } else if (type === 'kernek_extra') {
        // Kernek yang login memilih 1 orang kernek tambahan
        if (window.tripState.selectedKernekIds.includes(userId)) {
            window.tripState.selectedKernekIds = [];
        } else {
            window.tripState.selectedKernekIds = [userId];
        }
    } else {
        // Sopir yang login memilih kernek (bisa 1 atau 2 orang)
        let idx = window.tripState.selectedKernekIds.indexOf(userId);
        if (idx !== -1) {
            window.tripState.selectedKernekIds.splice(idx, 1);
        } else {
            if (window.tripState.selectedKernekIds.length >= 2) {
                // Maksimal 2 kernek: geser yang paling awal
                window.tripState.selectedKernekIds.shift();
            }
            window.tripState.selectedKernekIds.push(userId);
        }
    }
    renderArmadaKernekPills();
    updateEstimasiUpahSemuaCards();
}

function selectKernekChip(userId) {
    selectPartnerChip(userId, 'kernek');
}

function resetKernekSelection() {
    window.tripState.selectedKernekIds = [];
    renderArmadaKernekPills();
    updateEstimasiUpahSemuaCards();
}

// Muat Antrean DO Pengiriman Dikelompokkan per-Relasi (Konsumen)
async function refreshAntreanDriver() {
    let container = document.getElementById('driver-order-cards-list');
    if (!container) return;
    container.innerHTML = `<div style="text-align:center; padding:30px; color:#64748b; font-style:italic;">Mencari DO pakan menunggu pengiriman...</div>`;

    let today = new Date().toISOString().split('T')[0];
    let pendingTx = await fetchAntreanDOPengiriman(today);

    if (pendingTx.length === 0) {
        container.innerHTML = `
            <div style="background:#ffffff; border:1px dashed #cbd5e1; border-radius:12px; padding:30px 20px; text-align:center; margin-top:10px;">
                <span class="material-symbols-outlined" style="font-size:40px; color:#16a34a; margin-bottom:8px;">task_alt</span>
                <div style="font-size:14px; font-weight:800; color:#1e293b;">Semua Pakan Hari Ini Sudah Terkirim!</div>
                <div style="font-size:11px; color:#64748b; margin-top:4px;">Tidak ada pesanan DO menunggu pengiriman saat ini.</div>
            </div>
        `;
        return;
    }

    // Kelompokkan per-Relasi (Konsumen) dengan rincian item transaksi
    let relasiGroups = {};
    pendingTx.forEach(tx => {
        let rName = tx.relasi || 'Umum';
        if (!relasiGroups[rName]) {
            relasiGroups[rName] = {
                relasi: rName,
                alamat: tx.alamat || (window.tripState.cachedRelasiMap[rName]?.alamat) || '-',
                items: [],
                txItems: [],
                totalSisaKg: 0,
                txIds: []
            };
        }
        relasiGroups[rName].items.push(`${tx.pakan} (${tx.sisa_qty} Kg)`);
        relasiGroups[rName].txItems.push({
            id: tx.id,
            pakan: tx.pakan,
            sisa_qty: tx.sisa_qty
        });
        relasiGroups[rName].totalSisaKg += tx.sisa_qty;
        relasiGroups[rName].txIds.push(tx.id);
    });

    window.tripState.driverRelasiGroups = relasiGroups;

    // Ambil GPS Supir saat ini untuk kalkulasi jarak awal
    let currentGps = window.tripState.currentLegOrigin || await getCurrentGpsPosition();
    let nf = new Intl.NumberFormat('id-ID');

    let groupsArr = Object.values(relasiGroups);
    let routeInfoArr = await Promise.all(groupsArr.map(async grp => {
        let rData = window.tripState.cachedRelasiMap[grp.relasi] || {};
        let rLat = rData.lat ? parseFloat(rData.lat) : null;
        let rLng = rData.lng ? parseFloat(rData.lng) : null;
        if (rLat && rLng && currentGps.lat && currentGps.lng) {
            return await fetchJarakDanWaktuRiil(currentGps.lat, currentGps.lng, rLat, rLng);
        }
        return { km: 0, menit: 15, via: 'none' };
    }));

    let cardsHtml = groupsArr.map((grp, grpIdx) => {
        let safeKey = 'rel_' + grpIdx;
        let rData = window.tripState.cachedRelasiMap[grp.relasi] || {};
        let rLat = rData.lat ? parseFloat(rData.lat) : null;
        let rLng = rData.lng ? parseFloat(rData.lng) : null;

        // Estimasi Jarak Rute Jalan Riil & Waktu Tempuh via OSRM
        let routeInfo = routeInfoArr[grpIdx] || { km: 0, menit: 15 };
        let estimasiKm = routeInfo.km;
        let jarakLabel = estimasiKm > 0 ? `${estimasiKm} Km` : `<span style="color:#d97706; font-size:10px;">GPS Kandang Belum Ada</span>`;
        let estimasiMenit = routeInfo.menit || 15;

        // Flat Rp 15 / kg dibagi rata kru aktif (bisa Solo, bagi 2, atau bagi 3 tergantung kernek yang dipilih)
        let nKruActive = getActiveTripKruCount();
        let kruLabel = (nKruActive === 1) ? 'Solo' : `Bagi ${nKruActive}`;
        let escapedRelasi = grp.relasi.replace(/'/g, "\\'");

        let isSingleItem = (grp.txItems.length === 1);
        let totalInitialKg = 0;

        let itemInputsHtml = grp.txItems.map(it => {
            let defaultVal = Math.min(it.sisa_qty, KAPASITAS_PICKUP_NORMAL);
            totalInitialKg += defaultVal;
            return `
                <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; margin-bottom:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:12px; font-weight:800; color:#1e293b;">${it.pakan}</span>
                        <span style="font-size:11px; color:#64748b;">Sisa: <b style="color:#1e3a8a;">${nf.format(it.sisa_qty)} Kg</b></span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <input type="number" 
                               id="input-tx-${it.id}" 
                               class="input-bawa-tx input-bawa-${safeKey}" 
                               data-tx-id="${it.id}" 
                               data-pakan="${it.pakan.replace(/"/g, '&quot;')}" 
                               data-max="${it.sisa_qty}" 
                               value="${defaultVal}" 
                               min="0" 
                               max="${it.sisa_qty}" 
                               oninput="validasiDanHitungBawa('${safeKey}', this)"
                               onchange="validasiDanHitungBawa('${safeKey}', this)"
                               style="flex:1; padding:7px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; font-weight:800; text-align:center; color:#1e3a8a;">
                        <span style="font-size:11px; font-weight:700; color:#64748b;">Kg</span>
                        <button type="button" onclick="setBawaFullTx(${it.id}, ${it.sisa_qty}, '${safeKey}')" style="padding:6px 10px; font-size:11px; font-weight:700; background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:6px; cursor:pointer;">Semua</button>
                        <button type="button" onclick="setBawaNolTx(${it.id}, '${safeKey}')" style="padding:6px 10px; font-size:11px; font-weight:700; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer;">0</button>
                    </div>
                </div>
            `;
        }).join('');

        let totalUpahRit = totalInitialKg * TARIF_INSENTIF_TOTAL_PICKUP;
        let estimasiUpahKirim = Math.floor(Math.round(totalUpahRit) / nKruActive);
        let estimasiUpahOtot = estimasiUpahKirim; // backwards-compatibility

                let gmapsBtn = (rLat && rLng)
                    ? `<a href="https://www.google.com/maps/dir/?api=1&origin=${currentGps.lat},${currentGps.lng}&destination=${rLat},${rLng}" target="_blank" title="Cek rute di Google Maps" style="display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:700; color:#1d4ed8; background:#eff6ff; padding:2px 6px; border-radius:10px; text-decoration:none; border:1px solid #bfdbfe; margin-left:3px;">
                         <span class="material-symbols-outlined" style="font-size:12px; color:#2563eb;">map</span> Maps
                       </a>`
                    : '';

                return `
            <div style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:12px 14px; margin-bottom:12px; box-shadow:0 2px 5px rgba(0,0,0,0.03);">
                <!-- Header Kartu: Kiri Relasi & Alamat, Kanan Titik GPS & Estimasi Menit -->
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:8px;">
                    <div style="min-width:0; flex:1;">
                        <h4 style="margin:0; font-size:15px; font-weight:800; color:#1e293b;">${grp.relasi}</h4>
                        <div style="font-size:11px; color:#64748b; margin-top:2px; display:inline-flex; align-items:center; gap:3px;">
                            <span class="material-symbols-outlined" style="font-size:13px; color:#ef4444;">location_on</span>
                            <span>${grp.alamat}</span>
                        </div>
                    </div>
                    <!-- Kanan: Titik GPS & Estimasi Waktu (Pengganti Total Sisa) -->
                    <div style="text-align:right; flex-shrink:0;">
                        <div style="display:inline-flex; align-items:center; gap:3px; background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0; font-size:11px; font-weight:800; padding:3px 8px; border-radius:6px;">
                            <span class="material-symbols-outlined" style="font-size:13px;">navigation</span>
                            <span>${jarakLabel}</span> <span style="font-size:10px; color:#166534; font-weight:normal;">(~${estimasiMenit} mnt)</span>
                        </div>
                        ${gmapsBtn ? `<div style="margin-top:3px; text-align:right;">${gmapsBtn}</div>` : ''}
                    </div>
                </div>

                <!-- Daftar Input Qty per Jenis Pakan -->
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:10px; margin-bottom:10px;">
                    <div style="font-size:11px; font-weight:700; color:#475569; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                        <span>${isSingleItem ? 'Muatan yang Dibawa Rit Ini:' : 'Pilih & Tentukan Kg per Jenis Pakan:'}</span>
                        ${!isSingleItem ? `<button type="button" onclick="setBawaSemuaItemRelasi('${safeKey}')" style="background:none; border:none; color:#2563eb; font-size:11px; font-weight:700; cursor:pointer; text-decoration:underline;">Bawa Semua</button>` : ''}
                    </div>
                    ${itemInputsHtml}
                </div>

                <!-- Bagian Eksekusi Berangkat -->
                <div style="border-top:1px dashed #e2e8f0; padding-top:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span style="font-size:11px; font-weight:700; color:#475569;">Total Muatan Dibawa:</span>
                        <strong style="font-size:13px; font-weight:800; color:#15803d;">
                            <span id="label-total-kg-${safeKey}">${nf.format(totalInitialKg)}</span> Kg
                        </strong>
                    </div>
                    <button type="button" id="btn-antar-${safeKey}" data-kru="${nKruActive}" onclick="mulaiAntarKonsumen('${safeKey}', '${escapedRelasi}')" style="width:100%; background:linear-gradient(135deg, #2563eb, #1d4ed8); color:white; border:none; padding:11px 14px; border-radius:8px; font-size:13px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; box-shadow:0 2px 6px rgba(37,99,235,0.25);">
                        <span class="material-symbols-outlined" style="font-size:18px;">local_shipping</span> Berangkatkan (+Rp <span id="btn-upah-${safeKey}">${nf.format(estimasiUpahKirim)}</span>)
                    </button>
                    <!-- Hidden element for backwards compatibility -->
                    <span id="btn-kg-${safeKey}" style="display:none;">${nf.format(totalInitialKg)}</span>
                    <small style="color:#94a3b8; font-size:10px; display:block; margin-top:4px; text-align:center;">*Upah dihitung Rp 15/kg dibagi rata kru <span id="kru-label-${safeKey}">(${kruLabel})</span>.</small>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = cardsHtml;
}

// Helper validasi batasan muatan agar tidak melebihi sisa DO & kalkulasi total
function validasiDanHitungBawa(safeKey, inp) {
    if (inp) {
        let max = parseFloat(inp.dataset.max) || 0;
        let v = parseFloat(inp.value);
        if (isNaN(v) || v < 0) {
            inp.value = 0;
        } else if (v > max) {
            inp.value = max;
        }
    }
    hitungTotalBawaRelasi(safeKey);
}

// Helper kalkulasi total muatan per relasi di layar supir
function hitungTotalBawaRelasi(safeKey) {
    let inputs = document.querySelectorAll(`.input-bawa-${safeKey}`);
    let total = 0;
    inputs.forEach(inp => {
        let max = parseFloat(inp.dataset.max) || 0;
        let v = parseFloat(inp.value);
        if (isNaN(v) || v < 0) {
            inp.value = 0;
            v = 0;
        } else if (v > max) {
            inp.value = max;
            v = max;
        }
        total += v;
    });
    let lbl = document.getElementById(`label-total-kg-${safeKey}`);
    let btnKg = document.getElementById(`btn-kg-${safeKey}`);
    let btnUpah = document.getElementById(`btn-upah-${safeKey}`);
    let btnAntar = document.getElementById(`btn-antar-${safeKey}`);
    let nKru = btnAntar ? (parseInt(btnAntar.dataset.kru) || getActiveTripKruCount() || 1) : (getActiveTripKruCount() || 1);
    let upahPerKru = Math.floor(Math.round(total * TARIF_INSENTIF_TOTAL_PICKUP) / nKru);

    let nf = new Intl.NumberFormat('id-ID');
    if (lbl) lbl.innerText = nf.format(total);
    if (btnKg) btnKg.innerText = nf.format(total);
    if (btnUpah) {
        btnUpah.innerText = nf.format(upahPerKru);
        btnUpah.style.transition = 'transform 0.15s ease, color 0.15s ease';
        btnUpah.style.transform = 'scale(1.12)';
        btnUpah.style.color = '#fef08a';
        setTimeout(() => {
            if (btnUpah) {
                btnUpah.style.transform = 'scale(1)';
                btnUpah.style.color = '';
            }
        }, 180);
    }
}

function setBawaFullTx(txId, maxQty, safeKey) {
    let inp = document.getElementById(`input-tx-${txId}`);
    if (inp) {
        inp.value = maxQty;
        hitungTotalBawaRelasi(safeKey);
    }
}

function setBawaNolTx(txId, safeKey) {
    let inp = document.getElementById(`input-tx-${txId}`);
    if (inp) {
        inp.value = 0;
        hitungTotalBawaRelasi(safeKey);
    }
}

function setBawaSemuaItemRelasi(safeKey) {
    let inputs = document.querySelectorAll(`.input-bawa-${safeKey}`);
    inputs.forEach(inp => {
        inp.value = inp.dataset.max || 0;
    });
    hitungTotalBawaRelasi(safeKey);
}

// Supir Klik "Berangkatkan" Orderan Konsumen Tertentu
async function mulaiAntarKonsumen(safeKey, namaRelasi) {
    let inputs = document.querySelectorAll(`.input-bawa-${safeKey}`);
    let manifestItems = [];
    let totalKg = 0;
    let rincianPakanText = [];

    for (let inp of inputs) {
        let maxQty = parseFloat(inp.dataset.max) || 0;
        let qty = parseFloat(inp.value);
        let txId = parseInt(inp.dataset.txId);
        let pakan = inp.dataset.pakan || 'Pakan';

        if (isNaN(qty) || qty < 0) {
            inp.value = 0;
            hitungTotalBawaRelasi(safeKey);
            return alert(`Jumlah muatan ${pakan} tidak boleh bernilai negatif atau kosong!`);
        }

        if (qty > maxQty) {
            inp.value = maxQty;
            hitungTotalBawaRelasi(safeKey);
            return alert(`Jumlah muatan ${pakan} (${qty} Kg) tidak boleh melebihi sisa pesanan (${maxQty} Kg)! Nilai telah disesuaikan.`);
        }
        if (qty > 0) {
            manifestItems.push({
                tx_id: txId,
                relasi: namaRelasi,
                pakan: pakan,
                qty: qty
            });
            totalKg += qty;
            rincianPakanText.push(`${pakan} (${qty} Kg)`);
        }
    }

    if (totalKg <= 0 || manifestItems.length === 0) {
        return alert("Pilih / masukkan minimal 1 jenis pakan dengan muatan lebih dari 0 Kg!");
    }

    let armada = window.tripState.currentArmada || 'D 8070 UE';
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    let myRole = (meUser?.role || (typeof currentRole !== 'undefined' ? currentRole : '') || 'sopir').toLowerCase();

    let sopirId = null;
    let kernek1Id = null;
    let kernek2Id = null;

    if (myRole.includes('kernek')) {
        // Kernek yang memegang HP:
        kernek1Id = meUser ? meUser.id : null;
        sopirId = window.tripState.selectedSopirId;
        kernek2Id = window.tripState.selectedKernekIds?.[0] || null; // kernek tambahan jika ada

        if (!sopirId) {
            return alert("⚠️ Harap pilih siapa Sopir yang mengemudikan armada hari ini terlebih dahulu!");
        }
    } else {
        // Sopir yang memegang HP:
        sopirId = meUser ? meUser.id : null;
        kernek1Id = window.tripState.selectedKernekIds?.[0] || null;
        kernek2Id = window.tripState.selectedKernekIds?.[1] || null;

        if (!kernek1Id && !kernek2Id) {
            let lanjut = confirm("Anda belum memilih Kernek pendamping. Lanjutkan pengiriman sendirian?");
            if (!lanjut) return;
        }
    }

    let btn = document.getElementById(`btn-antar-${safeKey}`);
    let origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px; animation:spin 1s linear infinite;">sync</span> Mengunci GPS...`;
    }

    // Ambil GPS Titik Awal (Origin)
    let gpsStart = await getCurrentGpsPosition();
    if (gpsStart.isFallback && window.tripState.currentLegOrigin) {
        gpsStart.lat = window.tripState.currentLegOrigin.lat;
        gpsStart.lng = window.tripState.currentLegOrigin.lng;
    }

    let payloadTrip = {
        tanggal: new Date().toISOString().split('T')[0],
        cabang: 'PM',
        armada: armada,
        sopir_user_id: sopirId,
        kernek_1_user_id: kernek1Id,
        kernek_2_user_id: kernek2Id,
        total_kg: totalKg,
        status_trip: 'BERANGKAT',
        status_klaim: 'BELUM_KLAIM',
        waktu_berangkat: new Date().toISOString(),
        lat_start: gpsStart.lat,
        lng_start: gpsStart.lng,
        catatan: `Antar ke ${namaRelasi}: ${rincianPakanText.join(', ')}`,
        manifest_items: manifestItems
    };

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(payloadTrip)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || "Gagal memulai trip");
        }

        let createdTrips = await res.json();
        let activeTrip = createdTrips[0];
        window.tripState.activeTripItem = activeTrip;

        alert(`🚀 Berangkat! Anda sedang menuju ke ${namaRelasi} (${totalKg} Kg: ${rincianPakanText.join(', ')}).`);
        
        // Broadcast Realtime ke HP Partner (Sopir / Kernek) & Admin Monitor
        if (typeof broadcastRealtimeUpdate === 'function') {
            broadcastRealtimeUpdate({
                tipe: 'TRIP_UPDATE',
                armada: armada,
                relasi: namaRelasi,
                status: 'BERANGKAT',
                petugas: activeUser,
                timestamp: Date.now()
            });
        }

        // Beralih ke Tampilan Trip Sedang Berjalan
        tampilkanLayarTripBerjalan(activeTrip, namaRelasi, totalKg);
    } catch (e) {
        alert("Gagal memulai perjalanan: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origBtnHtml;
        }
    }
}

// Cek apakah ada Trip yang sedang berjalan untuk akun yang sedang login
async function cekTripAktifDriver() {
    let today = new Date().toISOString().split('T')[0];
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) return;

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=eq.${today}&status_trip=eq.BERANGKAT&or=(sopir_user_id.eq.${meUser.id},kernek_1_user_id.eq.${meUser.id},kernek_2_user_id.eq.${meUser.id})&order=created_at.desc&limit=1`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (res.ok) {
            let trips = await res.json();
            if (trips.length > 0) {
                let activeTrip = trips[0];
                window.tripState.activeTripItem = activeTrip;
                let relasiNama = activeTrip.manifest_items?.[0]?.relasi || 'Konsumen';
                let qtyKg = activeTrip.total_kg || 0;
                tampilkanLayarTripBerjalan(activeTrip, relasiNama, qtyKg);
            }
        }
    } catch (e) {
        console.warn("Cek trip aktif gagal:", e);
    }
}

// Tampilkan Kartu Trip Sedang Berjalan (Dengan Kamera Foto Bukti & Selesai)
function tampilkanLayarTripBerjalan(trip, namaRelasi, qtyKg) {
    let container = document.getElementById('driver-active-trip-box');
    let orderListContainer = document.getElementById('driver-order-cards-list');
    let pillsContainer = document.getElementById('driver-pill-selectors-box');
    if (!container) return;

    if (orderListContainer) orderListContainer.classList.add('hidden');
    if (pillsContainer) pillsContainer.classList.add('hidden');
    container.classList.remove('hidden');

    let nf = new Intl.NumberFormat('id-ID');

    container.innerHTML = `
        <div style="background:#ffffff; border:2px solid #2563eb; border-radius:14px; padding:18px; margin-bottom:15px; box-shadow:0 4px 12px rgba(37,99,235,0.15);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="background:#dbeafe; color:#1e40af; font-size:11px; font-weight:800; padding:3px 10px; border-radius:20px; display:inline-flex; align-items:center; gap:4px;">
                    <span class="material-symbols-outlined icon-spin" style="font-size:14px;">sync</span> SEDANG DALAM PERJALANAN
                </span>
                <span style="font-size:11px; font-weight:700; color:#475569;">${trip.armada}</span>
            </div>

            <h3 style="margin:0; font-size:18px; font-weight:800; color:#1e293b;">${namaRelasi}</h3>
            <div style="font-size:13px; color:#475569; margin-top:4px; display:inline-flex; align-items:center; gap:4px;">
                <span class="material-symbols-outlined" style="font-size:16px; color:#2563eb;">inventory_2</span>
                <span>Muatan: <b>${nf.format(qtyKg)} Kg</b></span>
            </div>

            <div style="background:#f8fafc; border-radius:8px; padding:12px; margin:14px 0; border:1px solid #e2e8f0; font-size:12px;">
                <div style="margin-bottom:6px; display:inline-flex; align-items:center; gap:4px; font-weight:700; color:#334155;">
                    <span class="material-symbols-outlined" style="font-size:16px; color:#2563eb;">photo_camera</span>
                    <span>Foto Bukti Penurunan / Surat Jalan TTD:</span>
                </div>
                <input type="file" id="driver-camera-input" accept="image/*" capture="environment" style="width:100%; font-size:11px; padding:6px; border:1px dashed #cbd5e1; border-radius:6px; background:#ffffff;">
                <div id="driver-photo-preview" style="margin-top:8px;"></div>
            </div>

            <div style="margin-top:14px; padding-top:12px; border-top:1px dashed #cbd5e1;">
                <div style="font-size:12px; font-weight:800; color:#1e293b; margin-bottom:8px;">
                    Langkah armada setelah pakan diturunkan:
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <button type="button" id="btn-selesai-kembali-pm" onclick="konfirmasiSelesaiPengiriman(${trip.id}, '${namaRelasi}', ${qtyKg}, true)" style="width:100%; background:linear-gradient(135deg, #16a34a, #15803d); color:white; border:none; padding:12px; border-radius:10px; font-size:13px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 3px 8px rgba(22,163,74,0.3);">
                        <span class="material-symbols-outlined" style="font-size:20px;">home</span> 1. Selesai & Kembali ke Gudang PM (PP)
                    </button>
                    <button type="button" id="btn-selesai-lanjut-antar" onclick="konfirmasiSelesaiPengiriman(${trip.id}, '${namaRelasi}', ${qtyKg}, false)" style="width:100%; background:linear-gradient(135deg, #2563eb, #1d4ed8); color:white; border:none; padding:11px; border-radius:10px; font-size:12px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 3px 8px rgba(37,99,235,0.25);">
                        <span class="material-symbols-outlined" style="font-size:18px;">local_shipping</span> 2. Lanjut Antar Orderan Lain (Estafet)
                    </button>
                </div>
            </div>
        </div>
    `;

    // Preview Foto saat dipilih
    document.getElementById('driver-camera-input')?.addEventListener('change', function(e) {
        let file = e.target.files[0];
        let previewDiv = document.getElementById('driver-photo-preview');
        if (file && previewDiv) {
            let reader = new FileReader();
            reader.onload = function(evt) {
                previewDiv.innerHTML = `<img src="${evt.target.result}" style="width:100%; max-height:160px; object-fit:cover; border-radius:6px; border:1px solid #cbd5e1;">`;
            };
            reader.readAsDataURL(file);
        }
    });
}

// Konfirmasi Pakan Selesai Diturunkan di Kandang
async function konfirmasiSelesaiPengiriman(tripId, namaRelasi, qtyKg, kembaliKeGudang = true) {
    let btnPm = document.getElementById('btn-selesai-kembali-pm');
    let btnLanjut = document.getElementById('btn-selesai-lanjut-antar');
    if (btnPm) { btnPm.disabled = true; btnPm.innerText = "Mengunci GPS & Mengunggah..."; }
    if (btnLanjut) { btnLanjut.disabled = true; }

    let fileInput = document.getElementById('driver-camera-input');
    let file = fileInput?.files?.[0];

    // Ambil GPS Titik Akhir (Kandang Peternak saat ini)
    let gpsEnd = await getCurrentGpsPosition();
    let uploadedPhotoUrl = null;

    // 1. Upload Foto Bukti jika ada
    if (file) {
        try {
            let filename = `BUKTI_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
            let resUpload = await fetch(`${SUPA_URL}/storage/v1/object/berkas_cbl/bukti_pengiriman/${filename}`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': file.type || 'image/jpeg'
                },
                body: file
            });
            if (resUpload.ok) {
                uploadedPhotoUrl = `${SUPA_URL}/storage/v1/object/public/berkas_cbl/bukti_pengiriman/${filename}`;
            }
        } catch (e) {
            console.warn("Gagal upload foto bukti:", e);
        }
    }

    // 2. Hitung Jarak Tempuh Leg ini via OSRM Rute Jalan Riil
    let trip = window.tripState.activeTripItem || {};
    let latStart = trip.lat_start || LAT_GUDANG_CBL;
    let lngStart = trip.lng_start || LNG_GUDANG_CBL;

    // Jarak Berangkat: dari Titik Berangkat -> Kandang Peternak (Rute Jalan)
    let ruteBerangkat = await fetchJarakDanWaktuRiil(latStart, lngStart, gpsEnd.lat, gpsEnd.lng);
    let legBerangkatKm = ruteBerangkat.km;

    // Jarak Pulang: jika supir konfirmasi kembali ke Gudang PM (Rute Jalan)
    let legPulangKm = 0;
    if (kembaliKeGudang) {
        let rutePulang = await fetchJarakDanWaktuRiil(gpsEnd.lat, gpsEnd.lng, LAT_GUDANG_CBL, LNG_GUDANG_CBL);
        legPulangKm = rutePulang.km;
    }

    let totalJarakKm = Math.round((legBerangkatKm + legPulangKm) * 10) / 10;

    let catatanTambahan = kembaliKeGudang 
        ? ` (PP ke Gudang PM, rute jalan ${totalJarakKm} Km)` 
        : ` (Lanjut estafet, rute jalan ${totalJarakKm} Km)`;

    let payloadUpdate = {
        status_trip: 'SELESAI',
        waktu_selesai: new Date().toISOString(),
        lat_end: gpsEnd.lat,
        lng_end: gpsEnd.lng,
        jarak_tempuh_km: totalJarakKm,
        poin_beban: 0,
        foto_bukti_url: uploadedPhotoUrl,
        catatan: (trip.catatan || '') + catatanTambahan
    };

    try {
        let resPatch = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(payloadUpdate)
        });

        // 3. Auto-Lock Koordinat Kandang di master_relasi jika belum ada
        if (!gpsEnd.isFallback) {
            await autoLockTitikKandang(namaRelasi, gpsEnd.lat, gpsEnd.lng);
        }

        // 4. Update Titik Awal Terkini untuk pengantaran berikutnya
        if (kembaliKeGudang) {
            // Armada pulang ke pangkalan: titik awal berikutnya reset ke Gudang PM
            window.tripState.currentLegOrigin = {
                lat: LAT_GUDANG_CBL,
                lng: LNG_GUDANG_CBL,
                namaTitik: 'Gudang PM'
            };
        } else {
            // Armada lanjut estafet: titik awal pengiriman berikutnya adalah kandang saat ini
            window.tripState.currentLegOrigin = {
                lat: gpsEnd.lat,
                lng: gpsEnd.lng,
                namaTitik: namaRelasi
            };
        }
        window.tripState.activeTripItem = null;

        // 5. Hitung Hadiah Insentif Flat Rp 15/kg Dibagi Rata Kru yang Bertugas
        let hasK2 = !!trip.kernek_2_user_id;
        let hasK1 = !!trip.kernek_1_user_id;
        let nKru = hasK2 ? 3 : (hasK1 ? 2 : 1);
        let upahKirimDapat = Math.round((qtyKg * TARIF_INSENTIF_TOTAL_PICKUP) / nKru);

        tampilkanModalSelebrasi(namaRelasi, upahKirimDapat, totalJarakKm, kembaliKeGudang);

        // Reset Tampilan
        document.getElementById('driver-active-trip-box')?.classList.add('hidden');
        document.getElementById('driver-order-cards-list')?.classList.remove('hidden');
        document.getElementById('driver-pill-selectors-box')?.classList.remove('hidden');

        refreshAntreanDriver();
        loadDompetDriver();
        loadDriverMonthlyStats();

        // Broadcast Realtime ke HP partner dan admin
        if (typeof broadcastRealtimeUpdate === 'function') {
            broadcastRealtimeUpdate({
                tipe: 'TRIP_UPDATE',
                armada: trip.armada,
                relasi: namaRelasi,
                status: 'SELESAI',
                petugas: activeUser,
                timestamp: Date.now()
            });
        }
    } catch (e) {
        alert("Gagal konfirmasi selesai: " + e.message);
    } finally {
        if (btnPm) { btnPm.disabled = false; btnPm.innerText = "1. Selesai & Kembali ke Gudang PM (PP)"; }
        if (btnLanjut) { btnLanjut.disabled = false; }
    }
}

// Pop-up Selebrasi Psikologis (+Rp Masuk ke Dompet!)
function tampilkanModalSelebrasi(namaRelasi, rupiahKirim, legKm, kembaliKeGudang = true) {
    let modal = document.getElementById('driver-celebration-modal');
    if (!modal) return;
    let nf = new Intl.NumberFormat('id-ID');

    document.getElementById('celeb-nama-peternak').innerText = namaRelasi;
    document.getElementById('celeb-nominal-uang').innerText = `+Rp ${nf.format(rupiahKirim)}`;
    
    let infoKmText = kembaliKeGudang 
        ? `+${legKm} Km (Termasuk Pulang ke PM) rute jalan tercatat` 
        : `+${legKm} Km (Leg Antar) rute jalan tercatat`;
    document.getElementById('celeb-km-poin').innerText = infoKmText;

    modal.classList.remove('hidden');
    
    // Mainkan notifikasi audio jika ada
    try {
        let audio = new Audio('notif.wav');
        audio.play().catch(() => {});
    } catch (e) {}
}

function tutupModalSelebrasi() {
    document.getElementById('driver-celebration-modal')?.classList.add('hidden');
}

// ====================================================================
// 6. DOMPET DRIVER & KLAIM INSENTIF (SALDO BERJALAN & KARTU MUTASI)
// ====================================================================

let currentDompetFilter = 'bulanan';

function switchFilterDompetDriver(mode) {
    currentDompetFilter = mode;
    ['mingguan', 'bulanan', 'tahunan'].forEach(m => {
        let btn = document.getElementById(`btn-dompet-${m}`);
        if (btn) {
            btn.style.background = (m === mode) ? '#0f766e' : '#ffffff';
            btn.style.color = (m === mode) ? '#ffffff' : '#475569';
            btn.style.borderColor = (m === mode) ? '#0f766e' : '#cbd5e1';
        }
    });
    loadDompetDriver(mode);
}

function isUserInTrip(tr, userId) {
    if (!tr || !userId) return false;
    if (tr.sopir_user_id === userId) return true;
    if (tr.kernek_1_user_id === userId) return true;
    if (tr.kernek_2_user_id === userId) return true;
    if (Array.isArray(tr.pekerja_muat_ids) && tr.pekerja_muat_ids.includes(userId)) return true;
    return false;
}

function hitungUpahSayaDiTrip(tr, userId) {
    let isTruk = (tr.armada === 'Truk');
    let isMandiri = (tr.armada === 'Ambil Mandiri');
    let kg = parseFloat(tr.total_kg) || 0;
    let upah = 0;
    let porsiKg = 0;

    if (isTruk || isMandiri) {
        let pekerjaIds = Array.isArray(tr.pekerja_muat_ids) ? tr.pekerja_muat_ids : [];
        let nKru = pekerjaIds.length || 1;
        let totalUpahMuat = kg * TARIF_MUAT_BONGKAR_TRUK; // 15
        let perOrang = Math.floor(totalUpahMuat / nKru);
        let sisa = totalUpahMuat - (perOrang * nKru);
        let idx = pekerjaIds.indexOf(userId);
        if (idx !== -1) {
            upah += perOrang + (idx === nKru - 1 ? sisa : 0);
            porsiKg += Math.round(kg / nKru);
        }
        if (isTruk && tr.sopir_user_id === userId) {
            let titik = parseInt(tr.jumlah_titik) || 1;
            let solar = parseFloat(tr.uang_jalan_sopir) || (titik * UANG_SOLAR_TRUK_PER_TITIK);
            upah += solar;
        }
    } else {
        // Pick-Up
        let hasK2 = !!tr.kernek_2_user_id;
        let hasK1 = !!tr.kernek_1_user_id;
        let nKru = hasK2 ? 3 : (hasK1 ? 2 : 1);
        let totalUpahTrip = Math.round(kg * TARIF_INSENTIF_TOTAL_PICKUP);
        let perKru = Math.floor(totalUpahTrip / nKru);
        let sisa = totalUpahTrip - (perKru * nKru);
        porsiKg = Math.round(kg / nKru);

        if (tr.sopir_user_id === userId || tr.kernek_1_user_id === userId) {
            upah += perKru;
        } else if (tr.kernek_2_user_id === userId) {
            upah += (perKru + sisa);
        }
    }
    return { upah, porsiKg };
}

async function loadDompetDriver(filterMode = currentDompetFilter) {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) return;
    let users = window.tripState.cachedUsers || [];
    let userDict = {};
    users.forEach(u => { userDict[u.id] = u.nama; });
    let nf = new Intl.NumberFormat('id-ID');

    let now = new Date();
    let pad = n => String(n).padStart(2, '0');
    let startDate, endDate, labelPeriode;

    if (filterMode === 'mingguan') {
        let dStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        startDate = `${dStart.getFullYear()}-${pad(dStart.getMonth() + 1)}-${pad(dStart.getDate())}`;
        endDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        labelPeriode = `7 Hari Terakhir (${dStart.getDate()}/${dStart.getMonth() + 1} - ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()})`;
    } else if (filterMode === 'tahunan') {
        startDate = `${now.getFullYear()}-01-01`;
        endDate = `${now.getFullYear()}-12-31`;
        labelPeriode = `Tahun ${now.getFullYear()}`;
    } else {
        filterMode = 'bulanan';
        let lastDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        startDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
        endDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDate.getDate())}`;
        labelPeriode = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    }

    let elLabelPeriode = document.getElementById('dompet-periode-label');
    if (elLabelPeriode) elLabelPeriode.innerText = labelPeriode;

    let supaHeaders = { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` };

    // 1. Ambil seluruh trip yang belum dicairkan (status_klaim != SUDAH_CAIR) untuk saldo berjalan utama
    // 2. Ambil trip sesuai filter periode aktif untuk riwayat mutasi buku kas
    let urlPending = `${SUPA_URL}/rest/v1/trip_pengiriman?status_trip=eq.SELESAI&or=(status_klaim.is.null,status_klaim.neq.SUDAH_CAIR)&order=tanggal.desc,created_at.desc`;
    let urlPeriod = `${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,created_at.desc`;

    try {
        let [resPending, resPeriod] = await Promise.all([
            fetch(urlPending, { headers: supaHeaders }).then(r => r.ok ? r.json() : []),
            fetch(urlPeriod, { headers: supaHeaders }).then(r => r.ok ? r.json() : [])
        ]);

        // A. KALKULASI SALDO BERJALAN BELUM DICAIRKAN (TOP GREEN CARD & DETAIL KARTU PUTIH)
        let myPendingTrips = resPending.filter(tr => tr.status_trip === 'SELESAI' && isUserInTrip(tr, meUser.id));
        window.tripState.cachedUnclaimedTrips = myPendingTrips;

        let akumulasiPending = hitungAkumulasiInsentifPeriode(myPendingTrips, users);
        let myPendingData = akumulasiPending.userMap[meUser.id] || {
            totalKgMuat: 0,
            totalKgAntar: 0,
            totalKgAll: 0,
            upahMuatTotal: 0,
            totalBersih: 0,
            totalKm: 0,
            tripCount: 0
        };

        let saldoBelumCair = myPendingData.totalBersih;
        // Animasi count up nominal saldo berjalan di menu dompet
        animateCountUp('dompet-total-upah', saldoBelumCair, 750);

        let elRincianKgMuat = document.getElementById('dompet-rincian-kg-muat');
        if (elRincianKgMuat) elRincianKgMuat.innerText = `${nf.format(myPendingData.totalKgMuat)} Kg`;

        let elRincianKgAntar = document.getElementById('dompet-rincian-kg-antar');
        if (elRincianKgAntar) elRincianKgAntar.innerText = `${nf.format(myPendingData.totalKgAntar)} Kg`;

        let elRincianKgOtot = document.getElementById('dompet-rincian-kg-otot');
        if (elRincianKgOtot) elRincianKgOtot.innerText = `${nf.format(myPendingData.totalKgAll)} Kg`;

        let elKmSaya = document.getElementById('dompet-km-saya');
        if (elKmSaya) elKmSaya.innerText = `${myPendingData.totalKm} Km`;

        let elRincianRpOtot = document.getElementById('dompet-rincian-rp-otot');
        if (elRincianRpOtot) elRincianRpOtot.innerText = `Rp ${nf.format(saldoBelumCair)}`;

        // Backwards compatibility legacy elements
        let elMuat = document.getElementById('dompet-upah-muat');
        if (elMuat) elMuat.innerText = `${nf.format(myPendingData.totalKgAll)} Kg`;
        let elSubMuatKg = document.getElementById('dompet-sub-muat-kg');
        if (elSubMuatKg) elSubMuatKg.innerText = `(${myPendingData.tripCount} Rit)`;
        let elNgantar = document.getElementById('dompet-estimasi-ngantar');
        if (elNgantar) elNgantar.innerText = `${myPendingData.totalKm} Km`;
        let elOtot = document.getElementById('dompet-upah-otot');
        if (elOtot) elOtot.innerText = `Rp ${nf.format(saldoBelumCair)}`;
        let elTotalBersih = document.getElementById('dompet-total-bersih');
        if (elTotalBersih) elTotalBersih.innerText = `Rp ${nf.format(saldoBelumCair)}`;
        let elEstimasiJarak = document.getElementById('dompet-estimasi-jarak');
        if (elEstimasiJarak) elEstimasiJarak.innerText = `Rp ${nf.format(saldoBelumCair)}`;

        // B. RENDER BUKU MUTASI & RIWAYAT SESUAI FILTER PERIODE (KONSEP M-BANKING TRANSAKSI)
        let myPeriodTrips = resPeriod.filter(tr => tr.status_trip === 'SELESAI' && isUserInTrip(tr, meUser.id));
        window.tripState.cachedPeriodTrips = myPeriodTrips;
        window.tripState.currentFilterLabel = labelPeriode;
        window.tripState.currentFilterMode = filterMode;

        let totalUpahPeriode = 0;
        let totalCairPeriode = 0;
        let totalBelumCairPeriode = 0;

        let listRiwayat = document.getElementById('driver-riwayat-list');
        let tbodyRiwayat = document.getElementById('driver-riwayat-tbody');

        if (myPeriodTrips.length === 0) {
            let emptyMsg = `<div style="text-align:center; padding:30px 15px; color:#94a3b8; font-style:italic;">Belum ada riwayat transaksi pengantaran untuk periode ${labelPeriode}.</div>`;
            if (listRiwayat) listRiwayat.innerHTML = emptyMsg;
            if (tbodyRiwayat) tbodyRiwayat.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Belum ada riwayat.</td></tr>`;
        } else {
            let listHtml = myPeriodTrips.map(tr => {
                let isMandiri = (tr.armada === 'Ambil Mandiri');
                let isTruk = (tr.armada === 'Truk');
                let isBantuMuat = (isMandiri || isTruk);
                let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
                let trKg = parseFloat(tr.total_kg) || 0;

                let { upah: upahSaya, porsiKg } = hitungUpahSayaDiTrip(tr, meUser.id);
                let isCair = (tr.status_klaim === 'SUDAH_CAIR');

                totalUpahPeriode += upahSaya;
                if (isCair) totalCairPeriode += upahSaya;
                else totalBelumCairPeriode += upahSaya;

                let tglDisplay = tr.tanggal ? tr.tanggal.split('-').reverse().slice(0, 2).join('/') : '-';
                let waktuStr = tr.waktu_berangkat 
                    ? new Date(tr.waktu_berangkat).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) 
                    : '';
                let tglSubtitle = waktuStr ? `${tglDisplay} • ${waktuStr}` : tglDisplay;

                let pal = getAvatarPalette(rNama);
                let initials = getInitialsFromRelasi(rNama);

                return `
                    <div onclick="bukaModalRincianMutasiDriver(${tr.id})" style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #f1f5f9; cursor:pointer; background:#ffffff; transition:background 0.15s ease;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='#ffffff'">
                        <!-- Kiri: Avatar Inisial & Relasi / Tanggal / Tonase -->
                        <div style="display:flex; align-items:center; gap:12px; min-width:0; flex:1; padding-right:8px;">
                            <div style="width:40px; height:40px; border-radius:50%; background:${pal.bg}; color:${pal.text}; border:1px solid ${pal.border}; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:13px; flex-shrink:0; position:relative; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                                ${initials}
                                <span style="position:absolute; bottom:-2px; right:-2px; width:15px; height:15px; border-radius:50%; background:#ffffff; border:1px solid #e2e8f0; display:flex; align-items:center; justify-content:center; font-size:9px; box-shadow:0 1px 2px rgba(0,0,0,0.06);">
                                    ${isBantuMuat ? '📦' : '🚚'}
                                </span>
                            </div>
                            <div style="min-width:0; flex:1;">
                                <div style="font-size:13px; font-weight:800; color:#1e293b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    ${rNama}
                                </div>
                                <div style="font-size:11px; color:#64748b; margin-top:2px; display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
                                    <span>${tglSubtitle}</span>
                                    <span style="color:#cbd5e1;">•</span>
                                    <span style="font-weight:600; color:#475569;">${nf.format(trKg)} Kg</span>
                                    ${isBantuMuat ? '<span style="background:#fef3c7; color:#b45309; font-size:9px; font-weight:700; padding:1px 5px; border-radius:4px; margin-left:2px;">Bantu Muat</span>' : ''}
                                </div>
                            </div>
                        </div>

                        <!-- Kanan: Nominal Upah Bersih, Status Pencairan & Tombol Rincian -->
                        <div style="text-align:right; flex-shrink:0; display:flex; align-items:center; gap:6px;">
                            <div>
                                <div style="font-size:14px; font-weight:900; color:#15803d; letter-spacing:-0.2px;">
                                    +Rp ${nf.format(upahSaya)}
                                </div>
                                <div style="font-size:10px; font-weight:700; margin-top:2px; color:${isCair ? '#15803d' : '#b45309'}; display:flex; align-items:center; justify-content:flex-end; gap:3px;">
                                    <span style="width:6px; height:6px; border-radius:50%; background:${isCair ? '#22c55e' : '#f59e0b'};"></span>
                                    <span>${isCair ? 'Sudah Cair' : 'Belum Cair'}</span>
                                </div>
                            </div>
                            <button type="button" onclick="event.stopPropagation(); bukaModalRincianMutasiDriver(${tr.id})" style="background:#f8fafc; border:1px solid #e2e8f0; color:#475569; font-size:10px; font-weight:700; padding:4px 6px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:1px;" title="Lihat Rincian">
                                <span>Rincian</span>
                                <span class="material-symbols-outlined" style="font-size:12px; color:#64748b;">chevron_right</span>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            if (listRiwayat) listRiwayat.innerHTML = listHtml;
            if (tbodyRiwayat) tbodyRiwayat.innerHTML = '';
        }

        // Update Ringkasan Rekening Periode
        let elHistTotal = document.getElementById('dompet-hist-total');
        let elHistCair = document.getElementById('dompet-hist-cair');
        let elHistPending = document.getElementById('dompet-hist-pending');

        if (elHistTotal) elHistTotal.innerText = `Rp ${nf.format(totalUpahPeriode)}`;
        if (elHistCair) elHistCair.innerText = `Rp ${nf.format(totalCairPeriode)}`;
        if (elHistPending) elHistPending.innerText = `Rp ${nf.format(totalBelumCairPeriode)}`;

    } catch (err) {
        console.error("Gagal memuat data dompet supir:", err);
    }
}

// ====================================================================
// 6A. HELPER ANIMASI COUNT-UP & MODAL RINCIAN MUTASI (M-BANKING STYLE)
// ====================================================================

function animateCountUp(targetId, endValue, duration = 750) {
    let el = document.getElementById(targetId);
    if (!el) return;
    let target = Math.max(0, Math.round(Number(endValue) || 0));
    let startTime = null;
    let nf = new Intl.NumberFormat('id-ID');

    el.innerText = 'Rp 0';

    function step(currentTime) {
        if (!startTime) startTime = currentTime;
        let elapsed = currentTime - startTime;
        let progress = Math.min(elapsed / duration, 1);
        let ease = (progress === 1) ? 1 : 1 - Math.pow(2, -10 * progress);
        let current = Math.floor(target * ease);
        el.innerText = `Rp ${nf.format(current)}`;
        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            el.innerText = `Rp ${nf.format(target)}`;
        }
    }
    requestAnimationFrame(step);
}

const AVATAR_PALETTES = [
    { bg: '#fef3c7', text: '#b45309', border: '#fde68a' }, // Amber
    { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' }, // Blue
    { bg: '#f0fdf4', text: '#15803d', border: '#bbf7d0' }, // Green
    { bg: '#fdf2f8', text: '#be185d', border: '#fbcfe8' }, // Pink
    { bg: '#f3e8ff', text: '#7e22ce', border: '#e9d5ff' }, // Purple
    { bg: '#ecfeff', text: '#0e7490', border: '#a5f3fc' }  // Cyan
];

function getAvatarPalette(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let idx = Math.abs(hash) % AVATAR_PALETTES.length;
    return AVATAR_PALETTES[idx];
}

function getInitialsFromRelasi(relasi) {
    if (!relasi) return 'CBL';
    let clean = relasi.replace(/^(antar ke|muat truk ke|bantu muat ke)\s*/i, '').trim();
    let words = clean.split(/[\s-]+/).filter(Boolean);
    if (words.length === 0) return 'CBL';
    if (words.length === 1) {
        return words[0].slice(0, 2).toUpperCase();
    }
    return (words[0][0] + words[1][0]).toUpperCase();
}

// Buka Modal Rincian Mutasi / Transaksi Pengantaran Driver
function bukaModalRincianMutasiDriver(tripId) {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) return;

    let trips = window.tripState.cachedPeriodTrips || [];
    let tr = trips.find(t => String(t.id) === String(tripId));
    if (!tr) {
        let unclaimed = window.tripState.cachedUnclaimedTrips || [];
        tr = unclaimed.find(t => String(t.id) === String(tripId));
    }
    if (!tr) return;

    let nf = new Intl.NumberFormat('id-ID');
    let userDict = {};
    (window.tripState.cachedUsers || []).forEach(u => { userDict[u.id] = u.nama; });

    let isMandiri = (tr.armada === 'Ambil Mandiri');
    let isTruk = (tr.armada === 'Truk');
    let isBantuMuat = (isMandiri || isTruk);
    let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
    let trKg = parseFloat(tr.total_kg) || 0;

    let kruNames = [];
    let nKru = 1;
    if (isBantuMuat) {
        let pekerjaIds = Array.isArray(tr.pekerja_muat_ids) ? tr.pekerja_muat_ids : [];
        nKru = pekerjaIds.length || 1;
        kruNames = pekerjaIds.map(id => userDict[id] || `User #${id}`);
    } else {
        let sopirNama = userDict[tr.sopir_user_id] || 'Sopir';
        let k1Nama = userDict[tr.kernek_1_user_id];
        let k2Nama = userDict[tr.kernek_2_user_id];
        kruNames = [sopirNama, k1Nama, k2Nama].filter(Boolean);
        nKru = kruNames.length || 1;
    }
    let kruText = kruNames.join(' & ') || 'Kru';

    let { upah: upahSaya, porsiKg } = hitungUpahSayaDiTrip(tr, meUser.id);
    let isCair = (tr.status_klaim === 'SUDAH_CAIR');

    let tglDisplay = tr.tanggal ? tr.tanggal.split('-').reverse().join('/') : '-';
    let waktuStr = tr.waktu_berangkat 
        ? new Date(tr.waktu_berangkat).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) 
        : '';
    let tglWaktu = waktuStr ? `${tglDisplay}, ${waktuStr} WIB` : tglDisplay;

    // Set Data di Modal
    let elNom = document.getElementById('mutasi-modal-nominal');
    if (elNom) elNom.innerText = `+Rp ${nf.format(upahSaya)}`;

    let badgeEl = document.getElementById('mutasi-modal-status-badge');
    if (badgeEl) {
        if (isCair) {
            badgeEl.style.background = '#dcfce7';
            badgeEl.style.color = '#15803d';
            badgeEl.style.border = '1px solid #86efac';
            badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:13px;">check_circle</span> Sudah Cair (Lunas)';
        } else {
            badgeEl.style.background = '#fef3c7';
            badgeEl.style.color = '#b45309';
            badgeEl.style.border = '1px solid #fde68a';
            badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:13px;">hourglass_top</span> Belum Dicairkan (Saldo Berjalan)';
        }
    }

    let elTgl = document.getElementById('mutasi-modal-tgl');
    if (elTgl) elTgl.innerText = tglWaktu;

    let elAkt = document.getElementById('mutasi-modal-aktivitas');
    if (elAkt) elAkt.innerText = isBantuMuat ? 'Bantu Muat Gudang (Truk)' : `Antar Pick-Up (${tr.armada || '-'})`;

    let elRel = document.getElementById('mutasi-modal-relasi');
    if (elRel) elRel.innerText = rNama;

    let elKg = document.getElementById('mutasi-modal-total-kg');
    if (elKg) elKg.innerText = `${nf.format(trKg)} Kg`;

    let elKru = document.getElementById('mutasi-modal-kru');
    if (elKru) elKru.innerText = `${kruText} (${nKru} Orang)`;

    let elPorsi = document.getElementById('mutasi-modal-porsi-kg');
    if (elPorsi) elPorsi.innerText = `${nf.format(porsiKg)} Kg (Bagi rata ${nKru} kru)`;

    let elJarak = document.getElementById('mutasi-modal-jarak');
    if (elJarak) elJarak.innerText = `${tr.jarak_tempuh_km || 0} Km`;

    let elCat = document.getElementById('mutasi-modal-catatan');
    if (elCat) elCat.innerText = tr.catatan || '-';

    let modal = document.getElementById('modal-rincian-mutasi-driver');
    if (modal) modal.classList.remove('hidden');
}

function tutupModalRincianMutasi() {
    let modal = document.getElementById('modal-rincian-mutasi-driver');
    if (modal) modal.classList.add('hidden');
}

// ====================================================================
// 6B. CATAT BELI BENSIN / SOLAR ARMADA (INTEGRASI KE CASHFLOW UANG KELUAR)
// ====================================================================

function bukaModalCatatBBM() {
    let modal = document.getElementById('modal-catat-bbm-driver');
    if (!modal) return;

    let katSel = document.getElementById('bbm-input-kategori');
    if (katSel) katSel.value = 'BBM / Solar';

    let armadaSel = document.getElementById('bbm-input-armada');
    if (armadaSel && window.tripState.currentArmada) {
        armadaSel.value = window.tripState.currentArmada;
    }

    let tglInput = document.getElementById('bbm-input-tanggal');
    if (tglInput) {
        tglInput.value = new Date().toISOString().split('T')[0];
    }

    let nom = document.getElementById('bbm-input-nominal');
    if (nom) nom.value = '';
    let lit = document.getElementById('bbm-input-liter');
    if (lit) lit.value = '';
    let km = document.getElementById('bbm-input-km');
    if (km) km.value = '';
    let det = document.getElementById('bbm-input-detail');
    if (det) det.value = '';
    let prev = document.getElementById('bbm-foto-preview');
    if (prev) prev.innerHTML = '';
    let fileInp = document.getElementById('bbm-input-foto');
    if (fileInp) {
        fileInp.value = '';
        fileInp.onchange = function(e) {
            let f = e.target.files[0];
            if (f && prev) {
                let r = new FileReader();
                r.onload = (evt) => {
                    prev.innerHTML = `<img src="${evt.target.result}" style="width:100%; max-height:140px; object-fit:cover; border-radius:6px; border:1px solid #cbd5e1;">`;
                };
                r.readAsDataURL(f);
            }
        };
    }

    toggleKategoriOperasionalForm();
    modal.classList.remove('hidden');
}

function toggleKategoriOperasionalForm() {
    let kat = document.getElementById('bbm-input-kategori')?.value || 'BBM / Solar';
    let colLiter = document.getElementById('bbm-col-liter');
    let rowDetail = document.getElementById('bbm-row-detail');
    let labelNominal = document.getElementById('bbm-label-nominal');
    let iconEl = document.getElementById('bbm-kategori-icon');

    let iconMap = {
        'BBM / Solar': { icon: 'local_gas_station', color: '#2563eb' },
        'Ban / Isi Angin': { icon: 'tire_repair', color: '#dc2626' },
        'Servis / Ganti Oli': { icon: 'build', color: '#0284c7' },
        'Cuci Mobil': { icon: 'local_car_wash', color: '#0891b2' },
        'Operasional Lainnya': { icon: 'handyman', color: '#7c3aed' }
    };

    if (iconEl && iconMap[kat]) {
        iconEl.textContent = iconMap[kat].icon;
        iconEl.style.color = iconMap[kat].color;
    }

    if (kat === 'BBM / Solar') {
        if (colLiter) colLiter.style.display = 'block';
        if (rowDetail) rowDetail.style.display = 'none';
        if (labelNominal) labelNominal.innerHTML = `Nominal Biaya Bensin (Rp) <span style="color:#dc2626;">*Wajib</span>:`;
    } else {
        if (colLiter) colLiter.style.display = 'none';
        if (rowDetail) rowDetail.style.display = 'block';
        if (labelNominal) labelNominal.innerHTML = `Biaya / Ongkos (Rp) <span style="color:#dc2626;">*Wajib</span>:`;
    }
}

function tutupModalCatatBBM() {
    document.getElementById('modal-catat-bbm-driver')?.classList.add('hidden');
}

async function simpanBeliBBMDriver(e) {
    if (e) e.preventDefault();

    let kategori = document.getElementById('bbm-input-kategori')?.value || 'BBM / Solar';
    let armada = document.getElementById('bbm-input-armada')?.value || 'D 8070 UE';
    let tanggal = document.getElementById('bbm-input-tanggal')?.value || new Date().toISOString().split('T')[0];
    let metode = document.getElementById('bbm-input-metode')?.value || 'Cash';
    let nominal = parseInt(document.getElementById('bbm-input-nominal')?.value) || 0;
    let liter = parseFloat(document.getElementById('bbm-input-liter')?.value) || 0;
    let kmOdo = parseInt(document.getElementById('bbm-input-km')?.value) || 0;
    let detailCatatan = document.getElementById('bbm-input-detail')?.value?.trim() || '';
    let fileInput = document.getElementById('bbm-input-foto');
    let file = fileInput?.files?.[0];

    if (nominal <= 0) {
        return alert("Harap masukkan nominal biaya yang valid!");
    }

    let btn = document.getElementById('btn-simpan-bbm');
    let originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerText = "Mengirim ke Cashflow..."; }

    try {
        let buktiUrl = "-";
        if (file && typeof uploadGambarKeSupabase === 'function') {
            btn.innerText = "Mengunggah foto bukti...";
            let reader = new FileReader();
            let base64Promise = new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            let dataUrl = await base64Promise;
            let parts = dataUrl.split(',');
            let mime = parts[0].match(/:(.*?);/)[1];
            let base64 = parts[1];
            let rawFilename = `armada_${armada.replace(/\s+/g, '_')}_${tanggal}_${Date.now()}.jpg`;
            buktiUrl = await uploadGambarKeSupabase(base64, mime, 'cashflow', rawFilename);
        }

        let isBBM = (kategori === 'BBM / Solar');
        let descText = "";
        if (isBBM) {
            descText = `Beli BBM ${armada}`;
            if (liter > 0) descText += ` - ${liter} Liter`;
            if (kmOdo > 0) descText += ` - Spido: ${kmOdo} KM`;
            descText += ` (Oleh: ${activeUser || 'Driver'})`;
        } else {
            descText = `[${kategori}] ${armada}${detailCatatan ? ' - ' + detailCatatan : ''}`;
            if (kmOdo > 0) descText += ` - Spido: ${kmOdo} KM`;
            descText += ` (Oleh: ${activeUser || 'Driver'})`;
        }

        let payloadCF = {
            tanggal: tanggal,
            jenis: 'Keluar',
            metode: metode,
            kategori: isBBM ? 'BBM / Solar' : 'Operasional - Kendaraan / Servis',
            relasi: isBBM ? `SPBU (${armada})` : `Bengkel / Perawatan (${armada})`,
            nominal: nominal,
            diskon: 0,
            keterangan: descText,
            bukti_url: buktiUrl,
            petugas: activeUser || 'Driver'
        };

        let res = await fetch(`${SUPA_URL}/rest/v1/cashflow`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(payloadCF)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || "Gagal mencatat pengeluaran");
        }

        // Broadcast Realtime ke Kasir / Admin Kantor
        if (typeof broadcastRealtimeUpdate === 'function') {
            broadcastRealtimeUpdate(payloadCF);
        }

        tutupModalCatatBBM();
        alert(`✅ Berhasil! Laporan ${kategori} Rp ${new Intl.NumberFormat('id-ID').format(nominal)} untuk armada ${armada} telah tercatat di Laporan Uang Keluar.`);
        
        // Segarkan data di admin jika terbuka
        if (typeof loadLogBBMAdmin === 'function') {
            loadLogBBMAdmin();
        }
    } catch (err) {
        alert("Gagal mencatat operasional: " + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

// Beralih Tab di Layar Driver (Order Kirim vs Log Armada vs Dompet)
function pindahDriverTab(tab) {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    let myRole = (meUser?.role || (typeof currentRole !== 'undefined' ? currentRole : '') || 'sopir').toLowerCase();
    if (tab === 'armada' && myRole.includes('kernek')) {
        tab = 'order'; // Role kernek tidak memiliki akses log armada
    }

    document.querySelectorAll('#driver-nav .driver-nav-btn, #driver-nav .nav-item').forEach(n => {
        n.classList.remove('active');
        n.style.color = '';
    });
    let activeBtn = document.getElementById(`nav-driver-${tab}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    let viewOrder = document.getElementById('driver-view-order');
    let viewDompet = document.getElementById('driver-view-dompet');
    let viewArmada = document.getElementById('driver-view-armada');

    if (viewOrder) viewOrder.classList.add('hidden');
    if (viewDompet) viewDompet.classList.add('hidden');
    if (viewArmada) viewArmada.classList.add('hidden');

    if (tab === 'order') {
        if (viewOrder) viewOrder.classList.remove('hidden');
        refreshAntreanDriver();
    } else if (tab === 'armada') {
        if (viewArmada) viewArmada.classList.remove('hidden');
        loadArmadaDriver();
    } else {
        if (viewDompet) viewDompet.classList.remove('hidden');
        let elTotalUpah = document.getElementById('dompet-total-upah');
        if (elTotalUpah) elTotalUpah.innerText = 'Rp 0';
        loadDompetDriver();
    }
}

// Muat Log Khusus Armada yang Dipegang Supir yang Sedang Login
async function loadArmadaDriver() {
    let user = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser) || {};
    let uName = (user.nama || activeUser || '').toLowerCase();
    
    let targetArmada = 'D 8070 UE';
    let supirLabel = 'Hilman';
    let armadaDesc = 'Grand Max Pick-up';

    if (uName.includes('adi')) {
        targetArmada = 'D 8142 UK';
        supirLabel = 'Adi';
        armadaDesc = 'Pick-up Putih';
    } else if (uName.includes('hilman')) {
        targetArmada = 'D 8070 UE';
        supirLabel = 'Hilman';
        armadaDesc = 'Grand Max Pick-up';
    } else {
        // Kernek atau staf lain
        targetArmada = window.tripState.currentArmada || 'D 8070 UE';
        supirLabel = (targetArmada === 'D 8142 UK') ? 'Adi' : 'Hilman';
        armadaDesc = (targetArmada === 'D 8142 UK') ? 'Pick-up Putih' : 'Grand Max Pick-up';
    }

    let titleEl = document.getElementById('driver-armada-title');
    let subEl = document.getElementById('driver-armada-subtitle');
    if (titleEl) titleEl.innerText = `${targetArmada} (${armadaDesc})`;
    if (subEl) subEl.innerHTML = `Supir Penanggung Jawab: <b style="color:#1e3a8a;">${supirLabel}</b>`;

    let odoEl = document.getElementById('driver-armada-odo');
    let biayaEl = document.getElementById('driver-armada-biaya');
    let ritEl = document.getElementById('driver-armada-rit');
    let servisContainer = document.getElementById('driver-armada-servis-list');
    let ritContainer = document.getElementById('driver-armada-rit-list');

    let nf = new Intl.NumberFormat('id-ID');

    try {
        let p1 = fetch(`${SUPA_URL}/rest/v1/cashflow?jenis=eq.Keluar&order=tanggal.desc,created_at.desc&limit=150`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json());

        let p2 = fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?order=tanggal.desc,created_at.desc&limit=100`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json());

        let [rawCF, rawTrips] = await Promise.all([p1, p2]);

        // Filter expenses khusus armada ini
        let myExpenses = (Array.isArray(rawCF) ? rawCF : []).filter(item => {
            let str = `${item.armada || ''} ${item.relasi || ''} ${item.keterangan || ''}`.toUpperCase();
            return str.includes(targetArmada.toUpperCase());
        });

        // Filter trips khusus armada ini
        let myTrips = (Array.isArray(rawTrips) ? rawTrips : []).filter(t => {
            return (t.armada || '').toUpperCase().includes(targetArmada.toUpperCase());
        });

        // Odometer terakhir
        let lastOdo = '- KM';
        for (let item of myExpenses) {
            let m = (item.keterangan || '').match(/Spido:\s*([0-9]+)\s*KM/i);
            if (m) {
                lastOdo = `${nf.format(m[1])} KM`;
                break;
            }
        }

        let totalBiaya = myExpenses.reduce((s, i) => s + (parseFloat(i.nominal) || 0), 0);

        if (odoEl) odoEl.innerText = lastOdo;
        if (biayaEl) biayaEl.innerText = `Rp ${nf.format(totalBiaya)}`;
        if (ritEl) ritEl.innerText = `${myTrips.length} Rit`;

        // Render List Catatan Servis & BBM
        if (servisContainer) {
            if (myExpenses.length === 0) {
                servisContainer.innerHTML = `<div style="text-align:center; padding:25px; color:#94a3b8; font-style:italic; background:#ffffff; border-radius:10px; border:1px solid #e2e8f0;">Belum ada catatan servis/BBM untuk mobil ${targetArmada}.</div>`;
            } else {
                servisContainer.innerHTML = myExpenses.map(item => {
                    let ket = item.keterangan || '-';
                    let odoM = ket.match(/Spido:\s*([0-9]+)\s*KM/i);
                    let odoStr = odoM ? ` • Spido: ${nf.format(odoM[1])} KM` : '';

                    let katBadge = `<span style="background:#eff6ff; color:#1d4ed8; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px;">receipt</span> ${item.kategori || 'Operasional'}</span>`;
                    if ((item.kategori || '').includes('BBM')) {
                        katBadge = `<span style="background:#fef3c7; color:#b45309; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#d97706;">local_gas_station</span> BBM/Solar</span>`;
                    } else if (ket.toLowerCase().includes('ban') || ket.toLowerCase().includes('angin')) {
                        katBadge = `<span style="background:#fee2e2; color:#b91c1c; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#dc2626;">tire_repair</span> Ban/Angin</span>`;
                    } else if (ket.toLowerCase().includes('oli') || ket.toLowerCase().includes('servis')) {
                        katBadge = `<span style="background:#dbeafe; color:#1e40af; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#2563eb;">build</span> Servis/Oli</span>`;
                    } else if (ket.toLowerCase().includes('cuci')) {
                        katBadge = `<span style="background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#0284c7;">local_car_wash</span> Cuci Mobil</span>`;
                    }

                    let buktiBtn = (item.bukti_url && item.bukti_url !== '-')
                        ? `<a href="${item.bukti_url}" target="_blank" style="background:#eff6ff; color:#2563eb; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; text-decoration:none; display:inline-flex; align-items:center; gap:2px;">
                             <span class="material-symbols-outlined" style="font-size:12px;">receipt</span> Bukti
                           </a>`
                        : '';

                    return `
                        <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:8px; box-shadow:0 1px 3px rgba(0,0,0,0.02);">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                <div style="display:flex; align-items:center; gap:6px;">
                                    ${katBadge}
                                    <span style="font-size:10px; color:#64748b;">${item.tanggal}</span>
                                </div>
                                <div style="font-size:13px; font-weight:800; color:#15803d;">Rp ${nf.format(item.nominal)}</div>
                            </div>
                            <div style="font-size:11px; color:#334155; line-height:1.4;">${ket}</div>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:10px; color:#64748b;">
                                <span>Dicatat oleh: <b>${item.petugas || supirLabel}</b>${odoStr}</span>
                                ${buktiBtn}
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }

        // Render List Riwayat Perjalanan
        if (ritContainer) {
            if (myTrips.length === 0) {
                ritContainer.innerHTML = `<div style="text-align:center; padding:25px; color:#94a3b8; font-style:italic; background:#ffffff; border-radius:10px; border:1px solid #e2e8f0;">Belum ada riwayat pengantaran untuk mobil ${targetArmada}.</div>`;
            } else {
                ritContainer.innerHTML = myTrips.map(tr => {
                    let waktuStr = tr.waktu_berangkat 
                        ? new Date(tr.waktu_berangkat).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) 
                        : '-';
                    let manifest = tr.manifest_items || [];
                    let relasiList = [...new Set(manifest.map(m => m.relasi).filter(Boolean))].join(', ') || tr.catatan || 'Konsumen';
                    let pakanList = manifest.map(m => `${m.pakan} (${m.qty} Kg)`).join(', ') || '-';

                    let firstRelasi = manifest[0]?.relasi || tr.catatan;
                    let rData = firstRelasi ? (window.tripState.cachedRelasiMap[firstRelasi] || {}) : {};
                    let rLat = rData.lat ? parseFloat(rData.lat) : null;
                    let rLng = rData.lng ? parseFloat(rData.lng) : null;
                    let mapsBtn = (rLat && rLng)
                        ? `<a href="https://www.google.com/maps/dir/?api=1&origin=${LAT_GUDANG_CBL},${LNG_GUDANG_CBL}&destination=${rLat},${rLng}" target="_blank" style="display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:700; color:#1d4ed8; background:#eff6ff; padding:2px 6px; border-radius:4px; text-decoration:none;">
                             <span class="material-symbols-outlined" style="font-size:12px;">map</span> Maps
                           </a>`
                        : '';

                    return `
                        <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:8px; box-shadow:0 1px 3px rgba(0,0,0,0.02);">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">
                                <div>
                                    <div style="font-size:12px; font-weight:800; color:#1e3a8a;">${relasiList}</div>
                                    <div style="font-size:10px; color:#64748b;">${tr.tanggal} (${waktuStr}) • ${tr.jarak_tempuh_km || 0} Km PP</div>
                                </div>
                                ${mapsBtn}
                            </div>
                            <div style="font-size:11px; color:#475569; margin-top:4px;">${pakanList}</div>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:10px;">
                                <span style="font-weight:700; color:#15803d;">Total Muatan: ${nf.format(tr.total_kg || 0)} Kg</span>
                                <span style="background:#dcfce7; color:#15803d; font-weight:700; padding:2px 6px; border-radius:4px;">${tr.status_trip || 'SELESAI'}</span>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        if (servisContainer) servisContainer.innerHTML = `<div style="text-align:center; padding:20px; color:#dc2626;">Gagal memuat log: ${err.message}</div>`;
    }
}

function switchDriverArmadaSubTab(subtab) {
    let btnServis = document.getElementById('btn-tab-supir-servis');
    let btnRit = document.getElementById('btn-tab-supir-rit');
    let viewServis = document.getElementById('driver-armada-view-servis');
    let viewRit = document.getElementById('driver-armada-view-rit');

    if (subtab === 'servis') {
        if (btnServis) { btnServis.style.background = '#2563eb'; btnServis.style.color = '#ffffff'; btnServis.style.borderColor = '#2563eb'; }
        if (btnRit) { btnRit.style.background = '#ffffff'; btnRit.style.color = '#475569'; btnRit.style.borderColor = '#cbd5e1'; }
        if (viewServis) viewServis.classList.remove('hidden');
        if (viewRit) viewRit.classList.add('hidden');
    } else {
        if (btnServis) { btnServis.style.background = '#ffffff'; btnServis.style.color = '#475569'; btnServis.style.borderColor = '#cbd5e1'; }
        if (btnRit) { btnRit.style.background = '#2563eb'; btnRit.style.color = '#ffffff'; btnRit.style.borderColor = '#2563eb'; }
        if (viewServis) viewServis.classList.add('hidden');
        if (viewRit) viewRit.classList.remove('hidden');
    }
}


// Cetak Slip Klaim Upah Supir / Kernek (Kartu Piutang & Pengajuan Kasir)
function cetakSlipKlaimDriver() {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) {
        alert("Sesi kru/driver tidak ditemukan.");
        return;
    }

    let unclaimedTrips = window.tripState.cachedUnclaimedTrips || [];
    let periodTrips = window.tripState.cachedPeriodTrips || [];
    let filterLabel = window.tripState.currentFilterLabel || 'Bulan Ini';

    // Prioritaskan mencetak daftar trip yang belum dicairkan jika ada, atau daftar mutasi periode jika semua sudah cair
    let tripsToPrint = (unclaimedTrips.length > 0) ? unclaimedTrips : periodTrips;
    let isPengajuanKlaim = (unclaimedTrips.length > 0);

    if (tripsToPrint.length === 0) {
        alert("Tidak ada data pengantaran untuk dicetak.");
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');
    let userDict = {};
    (window.tripState.cachedUsers || []).forEach(u => { userDict[u.id] = u.nama; });

    let tglCetak = new Date().toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    let totalUpahPrint = 0;
    let totalKgPrint = 0;

    let rowsHtml = tripsToPrint.map((tr, idx) => {
        let isMandiri = (tr.armada === 'Ambil Mandiri');
        let isTruk = (tr.armada === 'Truk');
        let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
        let trKg = parseFloat(tr.total_kg) || 0;

        let kruNames = [];
        let nKru = 1;
        if (isMandiri || isTruk) {
            let pekerjaIds = Array.isArray(tr.pekerja_muat_ids) ? tr.pekerja_muat_ids : [];
            nKru = pekerjaIds.length || 1;
            kruNames = pekerjaIds.map(id => userDict[id] || `User #${id}`);
        } else {
            let sopirNama = userDict[tr.sopir_user_id] || 'Sopir';
            let k1Nama = userDict[tr.kernek_1_user_id];
            let k2Nama = userDict[tr.kernek_2_user_id];
            kruNames = [sopirNama, k1Nama, k2Nama].filter(Boolean);
            nKru = kruNames.length || 1;
        }
        let kruText = kruNames.join(' & ') || 'Kru';

        let { upah: upahSaya, porsiKg } = hitungUpahSayaDiTrip(tr, meUser.id);
        totalUpahPrint += upahSaya;
        totalKgPrint += porsiKg;

        let isCair = (tr.status_klaim === 'SUDAH_CAIR');
        let statusBadge = isCair 
            ? '<span style="color:#15803d; font-weight:700;">SUDAH CAIR</span>' 
            : '<span style="color:#b45309; font-weight:700;">BELUM DICAIRKAN</span>';

        let tglStr = tr.tanggal ? tr.tanggal.split('-').reverse().join('/') : '-';

        return `
            <tr>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:center;">${idx + 1}</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:center;">${tglStr}</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px;">
                    <strong>${rNama}</strong>
                    <div style="font-size:10px; color:#64748b;">${isMandiri || isTruk ? 'Bantu Muat Truk' : 'Antar Pick-Up'}</div>
                </td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:right;">
                    ${nf.format(trKg)} Kg
                    <div style="font-size:10px; color:#64748b;">(Porsi: ${nf.format(porsiKg)} Kg)</div>
                </td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:center; font-size:10px;">${kruText} (${nKru})</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:right; font-weight:bold; color:#15803d;">Rp ${nf.format(upahSaya)}</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:center; font-size:10px;">${statusBadge}</td>
            </tr>
        `;
    }).join('');

    let docTitle = isPengajuanKlaim 
        ? "FORM PENGAJUAN KLAIM UPAH INSENTIF" 
        : `KARTU PIUTANG & MUTASI UPAH (${filterLabel.toUpperCase()})`;

    let printWindow = window.open('', '_blank', 'width=900,height=950');
    if (!printWindow) {
        window.print();
        return;
    }

    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>${docTitle} - ${meUser.nama}</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                    padding: 24px;
                    color: #0f172a;
                    background: #fff;
                    margin: 0;
                }
                .header {
                    border-bottom: 2px solid #0f172a;
                    padding-bottom: 12px;
                    margin-bottom: 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                }
                .company-name {
                    font-size: 18px;
                    font-weight: 800;
                    color: #166534;
                    letter-spacing: 0.5px;
                }
                .company-sub {
                    font-size: 11px;
                    color: #64748b;
                    margin-top: 2px;
                }
                .badge-doc {
                    font-size: 11px;
                    font-weight: 700;
                    padding: 4px 10px;
                    background: #dcfce7;
                    color: #15803d;
                    border: 1px solid #86efac;
                    border-radius: 6px;
                    text-align: right;
                }
                .info-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 12px;
                    background: #f8fafc;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    padding: 12px 16px;
                    margin-bottom: 16px;
                    font-size: 12px;
                }
                .info-item {
                    display: flex;
                    justify-content: space-between;
                    padding: 2px 0;
                }
                .table-slip {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 11px;
                    margin-bottom: 20px;
                }
                .table-slip th {
                    background: #f1f5f9;
                    border: 1px solid #cbd5e1;
                    padding: 8px;
                    font-weight: 700;
                    color: #334155;
                }
                .total-card {
                    background: #f0fdf4;
                    border: 1.5px dashed #22c55e;
                    border-radius: 8px;
                    padding: 14px 18px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 28px;
                }
                .signatures {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr;
                    gap: 20px;
                    margin-top: 30px;
                    text-align: center;
                    font-size: 11px;
                }
                .sig-box {
                    padding-top: 55px;
                    border-top: 1px solid #334155;
                    font-weight: bold;
                }
                @media print {
                    body { padding: 0; }
                    .no-print { display: none; }
                }
            </style>
        </head>
        <body>
            <div class="no-print" style="margin-bottom:15px; display:flex; justify-content:flex-end; gap:8px;">
                <button onclick="window.print()" style="padding:8px 16px; background:#16a34a; color:white; border:none; border-radius:6px; font-weight:bold; cursor:pointer;">🖨️ Cetak Bukti / Simpan PDF</button>
                <button onclick="window.close()" style="padding:8px 16px; background:#94a3b8; color:white; border:none; border-radius:6px; cursor:pointer;">Tutup</button>
            </div>

            <div class="header">
                <div>
                    <div class="company-name">PT CBL CONNECT - LOGISTIK PENGIRIMAN PAKAN</div>
                    <div class="company-sub">Sistem Kartu Piutang & Manajemen Insentif Kru Lapangan</div>
                    <div style="font-size:14px; font-weight:bold; margin-top:6px; color:#0f172a;">${docTitle}</div>
                </div>
                <div class="badge-doc">
                    ${isPengajuanKlaim ? 'STATUS: PENGAJUAN KLAIM' : 'STATUS: MUTASI PIUTANG'}<br>
                    <span style="font-size:10px; font-weight:normal; color:#475569;">Waktu Cetak: ${tglCetak}</span>
                </div>
            </div>

            <div class="info-grid">
                <div>
                    <div class="info-item"><span style="color:#64748b;">Nama Petugas:</span> <strong>${meUser.nama}</strong></div>
                    <div class="info-item"><span style="color:#64748b;">Role / Jabatan:</span> <strong style="text-transform:capitalize;">${meUser.role}</strong></div>
                    <div class="info-item"><span style="color:#64748b;">Armada Standar:</span> <strong>${meUser.armada_default || '-'}</strong></div>
                </div>
                <div>
                    <div class="info-item"><span style="color:#64748b;">Tarif Per Kg:</span> <strong>Rp 15 / Kg (Bagi Rata Kru)</strong></div>
                    <div class="info-item"><span style="color:#64748b;">Jumlah Pengantaran:</span> <strong>${tripsToPrint.length} Rit</strong></div>
                    <div class="info-item"><span style="color:#64748b;">Periode Tampilan:</span> <strong>${filterLabel}</strong></div>
                </div>
            </div>

            <table class="table-slip">
                <thead>
                    <tr>
                        <th style="width:30px;">No</th>
                        <th style="width:75px;">Tanggal</th>
                        <th>Aktivitas & Relasi Tujuan</th>
                        <th style="width:110px;">Muatan (Kg)</th>
                        <th style="width:130px;">Kru Bertugas</th>
                        <th style="width:110px;">Bagian Upah</th>
                        <th style="width:110px;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>

            <div class="total-card">
                <div>
                    <div style="font-size:11px; color:#166534; font-weight:600;">TOTAL ESTIMASI BEBAN FISIK DITANGANI:</div>
                    <div style="font-size:16px; font-weight:800; color:#15803d;">${nf.format(totalKgPrint)} Kg</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:11px; color:#166534; font-weight:600;">TOTAL UPAH BERSIH KLAIM:</div>
                    <div style="font-size:22px; font-weight:900; color:#15803d;">Rp ${nf.format(totalUpahPrint)}</div>
                </div>
            </div>

            <div class="signatures">
                <div>
                    <p style="margin-bottom:50px;">Petugas Pengaju,</p>
                    <div class="sig-box">${meUser.nama}<br><span style="font-weight:normal; font-size:10px; color:#64748b;">(${meUser.role})</span></div>
                </div>
                <div>
                    <p style="margin-bottom:50px;">Kasir / Keuangan,</p>
                    <div class="sig-box">( ........................................ )<br><span style="font-weight:normal; font-size:10px; color:#64748b;">Verifikasi Pencairan</span></div>
                </div>
                <div>
                    <p style="margin-bottom:50px;">Koordinator Logistik,</p>
                    <div class="sig-box">Pak Agus<br><span style="font-weight:normal; font-size:10px; color:#64748b;">Koordinator Armada & Logistik</span></div>
                </div>
            </div>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
}

// ====================================================================
// 7. SISI ADMIN: MONITORING & MUAT TRUK
// ====================================================================

// Inisialisasi Halaman Admin (Monitoring & Muat Truk)
async function initModulTripAdmin() {
    await loadMasterDataTrip();
    let today = new Date().toISOString().split('T')[0];
    await renderAdminAntreanDanMuatTruk(today);
    await loadMonitoringArmadaAdmin();
    await renderRekapPayrollAdmin();
}

// Render Antrean DO untuk Admin + Tombol "Kirim Pakai Truk"
async function renderAdminAntreanDanMuatTruk(tanggal) {
    let tbody = document.getElementById('admin-antrean-tbody');
    if (!tbody) return;

    let pendingTx = await fetchAntreanDOPengiriman(tanggal);
    let nf = new Intl.NumberFormat('id-ID');

    if (pendingTx.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Semua DO hari ini sudah dijadwalkan / terkirim.</td></tr>`;
        return;
    }

    // Kelompokkan per-Relasi
    let relasiGroups = {};
    pendingTx.forEach(tx => {
        let rName = tx.relasi || 'Umum';
        if (!relasiGroups[rName]) {
            relasiGroups[rName] = {
                relasi: rName,
                alamat: tx.alamat || '-',
                items: [],
                txItems: [],
                totalSisaKg: 0,
                txIds: []
            };
        }
        relasiGroups[rName].items.push(`${tx.pakan} (${tx.sisa_qty} Kg)`);
        relasiGroups[rName].txItems.push({
            id: tx.id,
            pakan: tx.pakan,
            sisa_qty: tx.sisa_qty
        });
        relasiGroups[rName].totalSisaKg += tx.sisa_qty;
        relasiGroups[rName].txIds.push(tx.id);
    });

    window.tripState.adminRelasiGroups = relasiGroups;

    tbody.innerHTML = Object.values(relasiGroups).map(grp => {
        let escapedRelasi = grp.relasi.replace(/'/g, "\\'");
        return `
            <tr style="border-bottom:1px solid #e2e8f0; font-size:12px;">
                <td style="padding:10px; font-weight:800; color:#1e293b;">${grp.relasi}</td>
                <td style="padding:10px; color:#475569;">${grp.items.join(', ')}</td>
                <td style="padding:10px; text-align:right; font-weight:800; color:#1e3a8a;">${nf.format(grp.totalSisaKg)} Kg</td>
                <td style="padding:10px; color:#64748b;">${grp.alamat}</td>
                <td style="padding:10px; text-align:center;">
                    <button type="button" onclick="bukaModalMuatTruk('${escapedRelasi}', ${grp.totalSisaKg})" style="background:#ea580c; color:white; border:none; padding:6px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 2px 4px rgba(234,88,12,0.25);">
                        <span class="material-symbols-outlined" style="font-size:15px;">local_shipping</span> Kirim Pakai Truk
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// Buka Modal Form Muat Truk
function bukaModalMuatTruk(namaRelasi, totalSisaKg) {
    let modal = document.getElementById('modal-muat-truk');
    if (!modal) return;

    let users = window.tripState.cachedUsers || [];
    let kruContainer = document.getElementById('modal-truk-kru-list');
    let itemsContainer = document.getElementById('modal-truk-items-container');
    let nf = new Intl.NumberFormat('id-ID');

    document.getElementById('modal-truk-relasi').innerText = namaRelasi;
    document.getElementById('modal-truk-sisa').innerText = `${nf.format(totalSisaKg)} Kg`;

    let grp = window.tripState.adminRelasiGroups?.[namaRelasi];
    let txItems = grp?.txItems || [];

    if (itemsContainer) {
        if (txItems.length === 0) {
            itemsContainer.innerHTML = `
                <input type="number" 
                       class="input-truk-item" 
                       data-tx-id="" 
                       data-pakan="Pakan" 
                       data-max="${totalSisaKg}" 
                       value="${totalSisaKg}" 
                       min="0" 
                       max="${totalSisaKg}" 
                       oninput="validasiDanHitungMuatTruk(this)" 
                       onchange="validasiDanHitungMuatTruk(this)" 
                       style="width:100%; padding:9px 10px; font-size:13px; font-weight:800; border:1px solid #cbd5e1; border-radius:8px; color:#1e3a8a;">
            `;
        } else {
            itemsContainer.innerHTML = txItems.map(it => `
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; margin-bottom:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:12px; font-weight:800; color:#1e293b;">${it.pakan}</span>
                        <span style="font-size:11px; color:#64748b;">Sisa: <b style="color:#9a3412;">${nf.format(it.sisa_qty)} Kg</b></span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <input type="number" 
                               id="input-truk-tx-${it.id}" 
                               class="input-truk-item" 
                               data-tx-id="${it.id}" 
                               data-pakan="${it.pakan.replace(/"/g, '&quot;')}" 
                               data-max="${it.sisa_qty}" 
                               value="${it.sisa_qty}" 
                               min="0" 
                               max="${it.sisa_qty}" 
                               oninput="validasiDanHitungMuatTruk(this)"
                               onchange="validasiDanHitungMuatTruk(this)"
                               style="flex:1; padding:7px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; font-weight:800; text-align:center; color:#1e3a8a;">
                        <span style="font-size:11px; font-weight:700; color:#64748b;">Kg</span>
                        <button type="button" onclick="setBawaFullTrukItem(${it.id}, ${it.sisa_qty})" style="padding:6px 10px; font-size:11px; font-weight:700; background:#fff7ed; color:#ea580c; border:1px solid #fed7aa; border-radius:6px; cursor:pointer;">Semua</button>
                        <button type="button" onclick="setBawaNolTrukItem(${it.id})" style="padding:6px 10px; font-size:11px; font-weight:700; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer;">0</button>
                    </div>
                </div>
            `).join('');
        }
    }

    hitungTotalMuatTruk();

    // Render Kru Gudang
    if (kruContainer) {
        kruContainer.innerHTML = users.map(u => `
            <label style="display:inline-flex; align-items:center; gap:6px; background:#f8fafc; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer; margin:3px;">
                <input type="checkbox" class="cb-truk-kru" value="${u.id}" style="accent-color:#ea580c; cursor:pointer;">
                <span>${u.nama}</span>
            </label>
        `).join('');
    }

    modal.classList.remove('hidden');
}

function validasiDanHitungMuatTruk(inp) {
    if (inp) {
        let max = parseFloat(inp.dataset.max) || 0;
        let v = parseFloat(inp.value);
        if (isNaN(v)) {
            if (inp.value !== '') inp.value = 0;
        } else if (v < 0) {
            inp.value = 0;
        } else if (v > max) {
            inp.value = max;
        }
    }
    hitungTotalMuatTruk();
}

function hitungTotalMuatTruk() {
    let inputs = document.querySelectorAll('.input-truk-item');
    let total = 0;
    inputs.forEach(inp => {
        let max = parseFloat(inp.dataset.max) || 0;
        let v = parseFloat(inp.value);
        if (isNaN(v) || v < 0) {
            inp.value = 0;
            v = 0;
        } else if (v > max) {
            inp.value = max;
            v = max;
        }
        total += v;
    });
    let totalDisplay = document.getElementById('modal-truk-total-display');
    let hiddenTotal = document.getElementById('modal-truk-input-kg');
    let nf = new Intl.NumberFormat('id-ID');
    if (totalDisplay) totalDisplay.innerText = nf.format(total);
    if (hiddenTotal) hiddenTotal.value = total;
}

function setBawaFullTrukItem(txId, maxQty) {
    let inp = document.getElementById(`input-truk-tx-${txId}`);
    if (inp) {
        inp.value = maxQty;
        hitungTotalMuatTruk();
    }
}

function setBawaNolTrukItem(txId) {
    let inp = document.getElementById(`input-truk-tx-${txId}`);
    if (inp) {
        inp.value = 0;
        hitungTotalMuatTruk();
    }
}

function tutupModalMuatTruk() {
    document.getElementById('modal-muat-truk')?.classList.add('hidden');
}

// Simpan Keberangkatan Truk oleh Admin
async function simpanKeberangkatanTruk() {
    let namaRelasi = document.getElementById('modal-truk-relasi')?.innerText;
    let inputs = document.querySelectorAll('.input-truk-item');
    let manifestItems = [];
    let totalKg = 0;
    let rincianPakanText = [];

    for (let inp of inputs) {
        let maxQty = parseFloat(inp.dataset.max) || 0;
        let qty = parseFloat(inp.value);
        let txId = inp.dataset.txId ? parseInt(inp.dataset.txId) : null;
        let pakan = inp.dataset.pakan || 'Pakan';

        if (isNaN(qty) || qty < 0) {
            inp.value = 0;
            hitungTotalMuatTruk();
            return alert(`Muatan ${pakan} tidak boleh negatif atau kosong!`);
        }

        if (qty > maxQty) {
            inp.value = maxQty;
            hitungTotalMuatTruk();
            return alert(`Muatan ${pakan} (${qty} Kg) melebihi sisa pesanan (${maxQty} Kg)! Nilai telah disesuaikan.`);
        }
        if (qty > 0) {
            manifestItems.push({
                tx_id: txId,
                relasi: namaRelasi,
                pakan: pakan,
                qty: qty
            });
            totalKg += qty;
            rincianPakanText.push(`${pakan} (${qty} Kg)`);
        }
    }

    if (totalKg <= 0 || manifestItems.length === 0) {
        return alert("Muatan truk harus lebih dari 0 Kg!");
    }

    let cbs = document.querySelectorAll('.cb-truk-kru:checked');
    let kruIds = Array.from(cbs).map(c => parseInt(c.value));

    if (kruIds.length === 0) {
        return alert("Pilih minimal 1 pekerja gudang yang ikut memuat & membongkar Truk!");
    }

    let btn = document.getElementById('btn-simpan-truk');
    if (btn) { btn.disabled = true; btn.innerText = "Menyimpan Keberangkatan Truk..."; }

    let payload = {
        tanggal: new Date().toISOString().split('T')[0],
        cabang: 'PM',
        armada: 'Truk',
        total_kg: totalKg,
        jumlah_titik: 1,
        uang_jalan_sopir: UANG_SOLAR_TRUK_PER_TITIK, // Rp 100.000
        pekerja_muat_ids: kruIds,
        status_trip: 'BERANGKAT',
        status_klaim: 'BELUM_KLAIM',
        waktu_berangkat: new Date().toISOString(),
        catatan: `Muat Truk ke ${namaRelasi}: ${rincianPakanText.join(', ')}`,
        manifest_items: manifestItems
    };

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || "Gagal menyimpan pengiriman truk");
        }

        alert(`✅ Pengiriman Truk Berhasil Diberangkatkan!\nMuatan: ${totalKg.toLocaleString('id-ID')} Kg\nKru: ${kruIds.length} Orang\nSolar Sopir: Rp 100.000`);
        tutupModalMuatTruk();

        let today = new Date().toISOString().split('T')[0];
        await renderAdminAntreanDanMuatTruk(today);
        await loadMonitoringArmadaAdmin();
        await renderRekapPayrollAdmin();
    } catch (e) {
        alert("Gagal: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "Simpan & Berangkatkan Truk"; }
    }
}

// Monitoring Armada & Barometer Keseimbangan Pick-Up
async function loadMonitoringArmadaAdmin() {
    let containerCards = document.getElementById('admin-monitoring-cards');
    let containerBarometer = document.getElementById('admin-barometer-container');
    let today = new Date().toISOString().split('T')[0];
    let trips = await fetchTripsByDateRange(today, today);
    let users = window.tripState.cachedUsers || [];
    let userDict = {};
    users.forEach(u => { userDict[u.id] = u.nama; });

    let nf = new Intl.NumberFormat('id-ID');

    // 1. Render Barometer Keseimbangan 100% Horizontal Stacked Bar
    if (containerBarometer) {
        let p1Kg = 0, p2Kg = 0, p1Km = 0, p2Km = 0;
        trips.forEach(tr => {
            if (tr.armada === 'D 8070 UE') {
                p1Kg += (parseFloat(tr.total_kg) || 0);
                p1Km += (parseFloat(tr.jarak_tempuh_km) || 0);
            } else if (tr.armada === 'D 8142 UK') {
                p2Kg += (parseFloat(tr.total_kg) || 0);
                p2Km += (parseFloat(tr.jarak_tempuh_km) || 0);
            }
        });

        let totalKg = p1Kg + p2Kg;
        let pctP1 = totalKg > 0 ? Math.round((p1Kg / totalKg) * 100) : 50;
        let pctP2 = totalKg > 0 ? (100 - pctP1) : 50;
        let isSeimbang = (pctP1 >= 40 && pctP1 <= 60);

        containerBarometer.innerHTML = `
            <div style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:15px; margin-bottom:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:13px; font-weight:800; color:#1e293b;">⚖️ Barometer Keseimbangan Pengiriman Pick-Up</span>
                    <span style="font-size:10px; font-weight:800; padding:3px 8px; border-radius:12px; background:${isSeimbang ? '#dcfce7' : '#fef3c7'}; color:${isSeimbang ? '#15803d' : '#b45309'};">
                        ${isSeimbang ? '✅ SEIMBANG (40-60%)' : '⚠️ KURANG SEIMBANG'}
                    </span>
                </div>
                <div style="height:22px; border-radius:6px; overflow:hidden; display:flex; background:#e2e8f0;">
                    <div style="width:${pctP1}%; background:#2563eb; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center;">D 8070 UE (${pctP1}%)</div>
                    <div style="width:${pctP2}%; background:#ea580c; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center;">D 8142 UK (${pctP2}%)</div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; font-size:11px; color:#475569;">
                    <div>• <b>D 8070 UE:</b> ${nf.format(p1Kg)} Kg | ${p1Km} Km</div>
                    <div>• <b>D 8142 UK:</b> ${nf.format(p2Kg)} Kg | ${p2Km} Km</div>
                </div>
            </div>
        `;
    }

    // 2. Render Kartu Monitoring Armada
    if (containerCards) {
        if (trips.length === 0) {
            containerCards.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8; font-style:italic;">Belum ada armada yang berangkat hari ini.</div>`;
            return;
        }

        containerCards.innerHTML = trips.map(tr => {
            let isSelesai = (tr.status_trip === 'SELESAI');
            let kruText = '';
            let badgeBg = isSelesai ? '#dcfce7' : '#dbeafe';
            let badgeColor = isSelesai ? '#15803d' : '#1e40af';
            let badgeText = isSelesai ? '✅ SELESAI' : '🚚 DI JALAN';

            if (tr.armada === 'Ambil Mandiri') {
                let namaPekerja = (tr.pekerja_muat_ids && tr.pekerja_muat_ids.length > 0)
                    ? tr.pekerja_muat_ids.map(id => userDict[id] || `ID ${id}`).join(', ')
                    : 'Customer Sendiri (Tanpa Insentif)';
                kruText = `🏪 <b>Ambil di Gudang</b> | <b>Bantu Muat:</b> ${namaPekerja}`;
                badgeBg = '#fef3c7';
                badgeColor = '#b45309';
                badgeText = '🏪 AMBIL MANDIRI';
            } else if (tr.armada === 'Truk') {
                let namaPekerja = (tr.pekerja_muat_ids || []).map(id => userDict[id] || `ID ${id}`).join(', ');
                kruText = `🚚 <b>Truk:</b> Solar Rp 100rb | <b>Kru Muat:</b> ${namaPekerja}`;
            } else {
                kruText = `👨‍✈️ <b>Sopir:</b> ${userDict[tr.sopir_user_id] || '-'} | 👷 <b>Kernek:</b> ${userDict[tr.kernek_1_user_id] || '-'}`;
            }

            let fotoBtn = '';
            if (tr.armada === 'Ambil Mandiri') {
                fotoBtn = `<span style="color:#64748b; font-size:10px; font-weight:600;">🏪 Selesai di Gudang</span>`;
            } else if (tr.foto_bukti_url) {
                fotoBtn = `<a href="${tr.foto_bukti_url}" target="_blank" style="background:#eff6ff; color:#2563eb; padding:4px 8px; border-radius:4px; font-size:10px; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; gap:2px;">📸 Lihat Foto Bukti</a>`;
            } else {
                fotoBtn = `<span style="color:#94a3b8; font-size:10px;">Belum ada foto</span>`;
            }

            let infoJarakMuatan = (tr.armada === 'Ambil Mandiri')
                ? `Muatan: <b>${nf.format(tr.total_kg)} Kg</b> (Ambil Mandiri)`
                : `Muatan: <b>${nf.format(tr.total_kg)} Kg</b> (${tr.jarak_tempuh_km || 0} Km)`;

            return `
                <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <span style="font-size:13px; font-weight:800; color:#1e293b;">${tr.armada}</span>
                            <span style="font-size:11px; color:#64748b; margin-left:6px;">(${tr.catatan || 'Pengiriman'})</span>
                        </div>
                        <span style="font-size:10px; font-weight:800; padding:2px 8px; border-radius:10px; background:${badgeBg}; color:${badgeColor};">
                            ${badgeText}
                        </span>
                    </div>
                    <div style="font-size:11px; color:#475569; margin:6px 0;">${kruText}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#64748b; border-top:1px dashed #f1f5f9; padding-top:6px;">
                        <span>${infoJarakMuatan}</span>
                        <div>${fotoBtn}</div>
                    </div>
                </div>
            `;
        }).join('');
    }
}

// Rekap Payroll & Tombol Tutup Periode Insentif
async function renderRekapPayrollAdmin() {
    let tbody = document.getElementById('admin-payroll-tbody');
    let tfoot = document.getElementById('admin-payroll-tfoot');
    if (!tbody) return;

    let today = new Date().toISOString().split('T')[0];
    let trips = await fetchTripsByDateRange(today, today);
    let users = window.tripState.cachedUsers || [];

    let akumulasi = hitungAkumulasiInsentifPeriode(trips, users);
    let nf = new Intl.NumberFormat('id-ID');

    let rows = Object.values(akumulasi.userMap).filter(u => u.totalBersih > 0 || u.tripCount > 0);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Belum ada insentif tercatat untuk hari ini.</td></tr>`;
        if (tfoot) tfoot.innerText = 'Rp 0';
        return;
    }

    tbody.innerHTML = rows.map(u => {
        let solarStr = (u.uangSolarTruk > 0) ? `Rp ${nf.format(u.uangSolarTruk)}` : '-';
        return `
            <tr style="border-bottom:1px solid #e2e8f0; font-size:11px;">
                <td style="padding:8px; font-weight:700; color:#1e293b;">${u.nama}</td>
                <td style="padding:8px; text-transform:capitalize; color:#64748b;">${u.role}</td>
                <td style="padding:8px; text-align:right; font-weight:600; color:#475569;">${nf.format(u.totalKgMuat || 0)} Kg</td>
                <td style="padding:8px; text-align:right; font-weight:600; color:#0f766e;">${nf.format(u.totalKgAntar || 0)} Kg</td>
                <td style="padding:8px; text-align:right; color:#2563eb; font-weight:700;">Rp ${nf.format(u.upahMuatTotal || 0)}</td>
                <td style="padding:8px; text-align:right; color:#d97706;">${solarStr}</td>
                <td style="padding:8px; text-align:right; font-weight:800; color:#15803d; font-size:12px;">Rp ${nf.format(u.totalBersih)}</td>
            </tr>
        `;
    }).join('');

    if (tfoot) tfoot.innerText = `Rp ${nf.format(akumulasi.grandTotal)}`;
}

// Tombol Admin: Cairkan & Tutup Periode Insentif
async function tutupPeriodeDanCairkanToples() {
    let konfirm = confirm("Apakah Anda yakin ingin MENUTUP & MENCAIRKAN PERIODE INSENTIF? Seluruh saldo trip berjalan yang belum dicairkan akan ditandai LUNAS / SUDAH CAIR.");
    if (!konfirm) return;

    let today = new Date().toISOString().split('T')[0];
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=lte.${today}&or=(status_klaim.is.null,status_klaim.neq.SUDAH_CAIR)`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify({ status_klaim: 'SUDAH_CAIR' })
        });

        alert("✅ Periode Insentif Berhasil Ditutup & Dicairkan! Slip gaji siap dibagikan.");
        renderRekapPayrollAdmin();
    } catch (e) {
        alert("Gagal menutup periode: " + e.message);
    }
}

function switchAdminTripTab(tab) {
    const tabs = ['antrean', 'monitor', 'payroll', 'bbm'];
    tabs.forEach(t => {
        let btn = document.getElementById(`tab-adm-${t}`);
        let view = document.getElementById(`view-adm-${t}`);
        if (btn) {
            btn.style.background = (t === tab) ? '#2563eb' : '#f1f5f9';
            btn.style.color = (t === tab) ? '#ffffff' : '#475569';
        }
        if (view) {
            if (t === tab) view.classList.remove('hidden');
            else view.classList.add('hidden');
        }
    });

    if (tab === 'antrean') {
        let today = new Date().toISOString().split('T')[0];
        renderAdminAntreanDanMuatTruk(today);
    } else if (tab === 'monitor') {
        loadMonitoringArmadaAdmin();
    } else if (tab === 'payroll') {
        renderRekapPayrollAdmin();
    } else if (tab === 'bbm') {
        loadLogBBMAdmin();
    }
}

// ====================================================================
// 8. LOG & PERAWATAN ARMADA (SISI ADMIN)
// ====================================================================

window._armadaActiveFilter = 'all';
window._armadaActiveSubtab = 'biaya';
window._cacheArmadaData = { expenses: [], trips: [] };

async function loadLogBBMAdmin() {
    let tbodyExpenses = document.getElementById('admin-bbm-tbody');
    let tbodyTrips = document.getElementById('admin-armada-rute-tbody');
    let summaryBox = document.getElementById('admin-bbm-summary');
    if (!tbodyExpenses) return;

    tbodyExpenses.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Memuat data operasional armada...</td></tr>`;
    if (tbodyTrips) {
        tbodyTrips.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Memuat riwayat perjalanan armada...</td></tr>`;
    }

    try {
        // 1. Ambil data pengeluaran armada (BBM, Servis, Ban, Cuci) dari cashflow
        let p1 = fetch(`${SUPA_URL}/rest/v1/cashflow?jenis=eq.Keluar&order=tanggal.desc,created_at.desc&limit=150`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json());

        // 2. Ambil riwayat perjalanan/rit dari trip_pengiriman
        let p2 = fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?order=tanggal.desc,created_at.desc&limit=100`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json());

        let [rawCF, rawTrips] = await Promise.all([p1, p2]);

        // Filter cashflow yang relevan dengan armada (BBM, Ban, Servis, Cuci, atau ada sebutan plat)
        let armadaExpenses = (Array.isArray(rawCF) ? rawCF : []).filter(item => {
            let kat = (item.kategori || '').toLowerCase();
            let rel = (item.relasi || '').toLowerCase();
            let ket = (item.keterangan || '').toLowerCase();

            let isArmadaRelated = kat.includes('bbm') || kat.includes('solar') || 
                                  kat.includes('kendaraan') || kat.includes('servis') || 
                                  kat.includes('operasional') || rel.includes('armada') || 
                                  rel.includes('spbu') || rel.includes('bengkel') ||
                                  ket.includes('d 8070 ue') || ket.includes('d 8142 uk') || 
                                  ket.includes('truk') || ket.includes('ban') || 
                                  ket.includes('angin') || ket.includes('oli');
            return isArmadaRelated;
        });

        window._cacheArmadaData = {
            expenses: armadaExpenses,
            trips: Array.isArray(rawTrips) ? rawTrips : []
        };

        renderArmadaLogViews();
    } catch (e) {
        if (tbodyExpenses) tbodyExpenses.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:25px; color:#dc2626;">Gagal memuat log armada: ${e.message}</td></tr>`;
    }
}

function filterLogArmada(armadaPlat) {
    window._armadaActiveFilter = armadaPlat;
    document.querySelectorAll('.btn-filter-armada').forEach(b => {
        let isSel = (b.dataset.armada === armadaPlat);
        b.style.background = isSel ? '#eff6ff' : '#ffffff';
        b.style.color = isSel ? '#1d4ed8' : '#475569';
        b.style.borderColor = isSel ? '#2563eb' : '#cbd5e1';
    });
    renderArmadaLogViews();
}

function switchSubTabArmada(subtab) {
    window._armadaActiveSubtab = subtab;
    let btnBiaya = document.getElementById('subtab-btn-biaya');
    let btnRute = document.getElementById('subtab-btn-rute');
    let viewBiaya = document.getElementById('subview-armada-biaya');
    let viewRute = document.getElementById('subview-armada-rute');

    if (subtab === 'biaya') {
        if (btnBiaya) { btnBiaya.style.background = '#2563eb'; btnBiaya.style.color = '#ffffff'; btnBiaya.style.borderColor = '#2563eb'; }
        if (btnRute) { btnRute.style.background = '#f8fafc'; btnRute.style.color = '#475569'; btnRute.style.borderColor = '#cbd5e1'; }
        if (viewBiaya) viewBiaya.classList.remove('hidden');
        if (viewRute) viewRute.classList.add('hidden');
    } else {
        if (btnBiaya) { btnBiaya.style.background = '#f8fafc'; btnBiaya.style.color = '#475569'; btnBiaya.style.borderColor = '#cbd5e1'; }
        if (btnRute) { btnRute.style.background = '#0f766e'; btnRute.style.color = '#ffffff'; btnRute.style.borderColor = '#0f766e'; }
        if (viewBiaya) viewBiaya.classList.add('hidden');
        if (viewRute) viewRute.classList.remove('hidden');
    }
}

function renderArmadaLogViews() {
    let nf = new Intl.NumberFormat('id-ID');
    let filter = window._armadaActiveFilter || 'all';
    let summaryBox = document.getElementById('admin-bbm-summary');
    let tbodyExpenses = document.getElementById('admin-bbm-tbody');
    let tbodyTrips = document.getElementById('admin-armada-rute-tbody');

    let allExpenses = window._cacheArmadaData.expenses || [];
    let allTrips = window._cacheArmadaData.trips || [];

    // Helper match armada plat
    function matchArmada(targetArmada, itemArmada, relasi, keterangan) {
        if (targetArmada === 'all') return true;
        let str = `${itemArmada || ''} ${relasi || ''} ${keterangan || ''}`.toUpperCase();
        return str.includes(targetArmada.toUpperCase());
    }

    let filteredExpenses = allExpenses.filter(item => {
        return matchArmada(filter, item.armada, item.relasi, item.keterangan);
    });

    let filteredTrips = allTrips.filter(t => {
        if (filter === 'all') return true;
        let arm = (t.armada || '').toUpperCase();
        return arm.includes(filter.toUpperCase());
    });

    // 1. KPI Aggregation & Data per Armada Tetap
    let expensesHilman = allExpenses.filter(i => matchArmada('D 8070 UE', i.armada, i.relasi, i.keterangan));
    let expensesAdi = allExpenses.filter(i => matchArmada('D 8142 UK', i.armada, i.relasi, i.keterangan));
    let tripsHilman = allTrips.filter(t => (t.armada || '').toUpperCase().includes('D 8070 UE'));
    let tripsAdi = allTrips.filter(t => (t.armada || '').toUpperCase().includes('D 8142 UK'));

    let biayaHilman = expensesHilman.reduce((sum, item) => sum + (parseFloat(item.nominal) || 0), 0);
    let biayaAdi = expensesAdi.reduce((sum, item) => sum + (parseFloat(item.nominal) || 0), 0);
    let lastNoteHilman = expensesHilman[0] || null;
    let lastNoteAdi = expensesAdi[0] || null;

    let totalBiaya = filteredExpenses.reduce((sum, item) => sum + (parseFloat(item.nominal) || 0), 0);
    let lastOdoMap = { 'D 8070 UE': '-', 'D 8142 UK': '-', 'Truk': '-' };

    allExpenses.forEach(item => {
        let ket = item.keterangan || '';
        let odoMatch = ket.match(/Spido:\s*([0-9]+)\s*KM/i);
        let arm = (item.relasi || '').replace('SPBU (', '').replace('Bengkel / Perawatan (', '').replace(')', '').trim();
        if (!arm || arm === 'SPBU' || arm === 'Bengkel / Perawatan') {
            if (ket.includes('D 8070 UE')) arm = 'D 8070 UE';
            else if (ket.includes('D 8142 UK')) arm = 'D 8142 UK';
            else if (ket.includes('Truk')) arm = 'Truk';
        }
        if (odoMatch && lastOdoMap[arm] === '-') {
            lastOdoMap[arm] = `${nf.format(odoMatch[1])} KM`;
        }
    });

    if (summaryBox) {
        let filterLabel = (filter === 'all') ? 'Semua Armada' : filter;
        summaryBox.innerHTML = `
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; margin-bottom:15px;">
                <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#1e40af; font-weight:700;">Total Biaya (${filterLabel})</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#1d4ed8;">Rp ${nf.format(totalBiaya)}</h3>
                    <div style="font-size:10px; color:#64748b; margin-top:2px;">BBM, Servis, Ban, Angin, Cuci</div>
                </div>
                <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#15803d; font-weight:700;">KM Odometer D 8070 UE</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#16a34a;">${lastOdoMap['D 8070 UE']}</h3>
                    <div style="font-size:10px; color:#15803d; margin-top:2px;">Grand Max Pick-up (Hilman)</div>
                </div>
                <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#c2410c; font-weight:700;">KM Odometer D 8142 UK</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#ea580c;">${lastOdoMap['D 8142 UK']}</h3>
                    <div style="font-size:10px; color:#c2410c; margin-top:2px;">Pick-up Putih (Adi)</div>
                </div>
                <div style="background:#f5f3ff; border:1px solid #ddd6fe; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#6d28d9; font-weight:700;">Total Rit Pengiriman</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#7c3aed;">${filteredTrips.length} Pengantaran</h3>
                    <div style="font-size:10px; color:#6d28d9; margin-top:2px;">Tercatat di sistem logistik</div>
                </div>
            </div>
        `;
    }

    // 2. Render Tabel Catatan Biaya & Servis
    if (tbodyExpenses) {
        if (filteredExpenses.length === 0) {
            tbodyExpenses.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Belum ada catatan operasional untuk filter ini.</td></tr>`;
        } else {
            tbodyExpenses.innerHTML = filteredExpenses.map(item => {
                let ket = item.keterangan || '-';
                let odoMatch = ket.match(/Spido:\s*([0-9]+)\s*KM/i);
                let odoStr = odoMatch ? `${nf.format(odoMatch[1])} KM` : '-';

                // Deteksi armada & supir badge
                let armName = 'Armada';
                if (ket.includes('D 8070 UE') || (item.relasi || '').includes('D 8070 UE')) armName = 'D 8070 UE (Hilman)';
                else if (ket.includes('D 8142 UK') || (item.relasi || '').includes('D 8142 UK')) armName = 'D 8142 UK (Adi)';
                else if (ket.includes('Truk') || (item.relasi || '').includes('Truk')) armName = 'Truk';

                let katBadge = `<span style="background:#eff6ff; color:#1d4ed8; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px;">receipt</span> ${item.kategori || 'Operasional'}</span>`;
                if ((item.kategori || '').includes('BBM')) {
                    katBadge = `<span style="background:#fef3c7; color:#b45309; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#d97706;">local_gas_station</span> BBM/Solar</span>`;
                } else if (ket.toLowerCase().includes('ban') || ket.toLowerCase().includes('angin')) {
                    katBadge = `<span style="background:#fee2e2; color:#b91c1c; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#dc2626;">tire_repair</span> Ban/Angin</span>`;
                } else if (ket.toLowerCase().includes('oli') || ket.toLowerCase().includes('servis')) {
                    katBadge = `<span style="background:#dbeafe; color:#1e40af; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#2563eb;">build</span> Servis/Oli</span>`;
                } else if (ket.toLowerCase().includes('cuci')) {
                    katBadge = `<span style="background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#0284c7;">local_car_wash</span> Cuci Mobil</span>`;
                }

                let fotoLink = (item.bukti_url && item.bukti_url !== '-')
                    ? `<a href="${item.bukti_url}" target="_blank" style="background:#eff6ff; color:#2563eb; padding:4px 8px; border-radius:6px; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; gap:3px;">
                         <span class="material-symbols-outlined" style="font-size:14px;">receipt</span> Bukti
                       </a>`
                    : `<span style="color:#94a3b8; font-size:10px;">-</span>`;

                return `
                    <tr style="border-bottom:1px solid #e2e8f0; font-size:11px;">
                        <td style="padding:10px 8px; font-weight:700; color:#1e293b;">${item.tanggal || '-'}</td>
                        <td style="padding:10px 8px; font-weight:800; color:#2563eb;">${armName}</td>
                        <td style="padding:10px 8px;">${katBadge}</td>
                        <td style="padding:10px 8px; color:#334155; max-width:220px;">${ket}</td>
                        <td style="padding:10px 8px; text-align:right; font-weight:700; color:#475569;">${odoStr}</td>
                        <td style="padding:10px 8px; text-align:right; font-weight:800; color:#15803d;">Rp ${nf.format(item.nominal)}</td>
                        <td style="padding:10px 8px; text-align:center;">
                            <span style="background:#f1f5f9; color:#475569; padding:2px 6px; border-radius:4px; font-weight:600;">${item.metode || 'Cash'}</span>
                        </td>
                        <td style="padding:10px 8px; color:#475569;">${item.petugas || '-'}</td>
                        <td style="padding:10px 8px; text-align:center;">${fotoLink}</td>
                    </tr>
                `;
            }).join('');
        }
    }

    // 3. Render Tabel Riwayat Perjalanan (Tracking Kemana Aja)
    if (tbodyTrips) {
        if (filteredTrips.length === 0) {
            tbodyTrips.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Belum ada riwayat pengantaran untuk armada ini.</td></tr>`;
        } else {
            let users = window.tripState.cachedUsers || [];
            let userMap = {};
            users.forEach(u => { userMap[u.id] = u.nama; });

            tbodyTrips.innerHTML = filteredTrips.map(tr => {
                let waktuStr = tr.waktu_berangkat 
                    ? new Date(tr.waktu_berangkat).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) 
                    : '-';
                let tglDisplay = `${tr.tanggal} (${waktuStr})`;

                let manifest = tr.manifest_items || [];
                let relasiList = [...new Set(manifest.map(m => m.relasi).filter(Boolean))].join(', ') || tr.catatan || 'Konsumen';
                let pakanList = manifest.map(m => `${m.pakan} (${m.qty} Kg)`).join(', ') || '-';

                // Tambahkan Maps button jika kandang terdaftar di master_relasi
                let firstRelasi = manifest[0]?.relasi || tr.catatan;
                let rData = firstRelasi ? (window.tripState.cachedRelasiMap[firstRelasi] || {}) : {};
                let rLat = rData.lat ? parseFloat(rData.lat) : null;
                let rLng = rData.lng ? parseFloat(rData.lng) : null;
                let mapsBtn = (rLat && rLng)
                    ? `<a href="https://www.google.com/maps/dir/?api=1&origin=${LAT_GUDANG_CBL},${LNG_GUDANG_CBL}&destination=${rLat},${rLng}" target="_blank" title="Cek rute di Google Maps" style="display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:700; color:#1d4ed8; background:#eff6ff; padding:2px 6px; border-radius:4px; text-decoration:none; margin-left:4px; border:1px solid #bfdbfe;">
                         <span class="material-symbols-outlined" style="font-size:12px; color:#2563eb;">map</span> Maps
                       </a>`
                    : '';

                let sopirNama = userMap[tr.sopir_user_id] || 'Supir';
                let kernekNama = userMap[tr.kernek_1_user_id] || '-';
                if (tr.kernek_2_user_id && userMap[tr.kernek_2_user_id]) {
                    kernekNama += `, ${userMap[tr.kernek_2_user_id]}`;
                }
                let kruStr = `<b>${sopirNama}</b>${kernekNama !== '-' ? ` & ${kernekNama}` : ''}`;

                let armLabel = tr.armada || '-';
                if (armLabel.includes('D 8070 UE')) armLabel = 'D 8070 UE (Hilman)';
                else if (armLabel.includes('D 8142 UK')) armLabel = 'D 8142 UK (Adi)';

                return `
                    <tr style="border-bottom:1px solid #e2e8f0; font-size:11px;">
                        <td style="padding:10px 8px; font-weight:700; color:#1e293b;">${tglDisplay}</td>
                        <td style="padding:10px 8px; font-weight:800; color:#0f766e;">${armLabel}</td>
                        <td style="padding:10px 8px; font-weight:700; color:#1e3a8a;">${relasiList} ${mapsBtn}</td>
                        <td style="padding:10px 8px; color:#334155; font-size:10px; max-width:200px;">${pakanList}</td>
                        <td style="padding:10px 8px; text-align:right; font-weight:800; color:#15803d;">${nf.format(tr.total_kg || 0)} Kg</td>
                        <td style="padding:10px 8px; color:#334155;">${kruStr}</td>
                        <td style="padding:10px 8px; text-align:right; font-weight:700; color:#475569;">${tr.jarak_tempuh_km || 0} Km</td>
                        <td style="padding:10px 8px; text-align:center;">
                            <span style="background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; padding:2px 6px; border-radius:10px;">${tr.status_trip || 'SELESAI'}</span>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }
}

function switchDriverPortalTab(tab) {
    pindahDriverTab(tab);
}

// Global Window Exports
window.initDriverPortal = initDriverPortal;
window.selectArmadaPill = selectArmadaPill;
window.selectKernekChip = selectKernekChip;
window.resetKernekSelection = resetKernekSelection;
window.mulaiAntarKonsumen = mulaiAntarKonsumen;
window.hitungTotalBawaRelasi = hitungTotalBawaRelasi;
window.setBawaFullTx = setBawaFullTx;
window.setBawaNolTx = setBawaNolTx;
window.setBawaSemuaItemRelasi = setBawaSemuaItemRelasi;
window.konfirmasiSelesaiPengiriman = konfirmasiSelesaiPengiriman;
window.tutupModalSelebrasi = tutupModalSelebrasi;
window.pindahDriverTab = pindahDriverTab;
window.switchDriverPortalTab = switchDriverPortalTab;
window.cetakSlipKlaimDriver = cetakSlipKlaimDriver;
window.refreshAntreanDriver = refreshAntreanDriver;
window.bukaModalCatatBBM = bukaModalCatatBBM;
window.tutupModalCatatBBM = tutupModalCatatBBM;
window.toggleKategoriOperasionalForm = toggleKategoriOperasionalForm;
window.simpanBeliBBMDriver = simpanBeliBBMDriver;
window.loadArmadaDriver = loadArmadaDriver;
window.switchDriverArmadaSubTab = switchDriverArmadaSubTab;
window.loadDriverMonthlyStats = loadDriverMonthlyStats;
window.switchFilterBulanDriver = switchFilterBulanDriver;
window.validasiDanHitungBawa = validasiDanHitungBawa;
window.loadDompetDriver = loadDompetDriver;
window.switchFilterDompetDriver = switchFilterDompetDriver;
window.isUserInTrip = isUserInTrip;
window.hitungUpahSayaDiTrip = hitungUpahSayaDiTrip;
window.bukaModalRincianMutasiDriver = bukaModalRincianMutasiDriver;
window.tutupModalRincianMutasi = tutupModalRincianMutasi;
window.animateCountUp = animateCountUp;

// Admin Window Exports
window.initModulTripAdmin = initModulTripAdmin;
window.switchAdminTripTab = switchAdminTripTab;
window.bukaModalMuatTruk = bukaModalMuatTruk;
window.tutupModalMuatTruk = tutupModalMuatTruk;
window.validasiDanHitungMuatTruk = validasiDanHitungMuatTruk;
window.hitungTotalMuatTruk = hitungTotalMuatTruk;
window.setBawaFullTrukItem = setBawaFullTrukItem;
window.setBawaNolTrukItem = setBawaNolTrukItem;
window.simpanKeberangkatanTruk = simpanKeberangkatanTruk;
window.tutupPeriodeDanCairkanToples = tutupPeriodeDanCairkanToples;
window.kunciTitikKandangPeternak = autoLockTitikKandang;
window.loadLogBBMAdmin = loadLogBBMAdmin;
window.filterLogArmada = filterLogArmada;
window.switchSubTabArmada = switchSubTabArmada;
window.renderArmadaLogViews = renderArmadaLogViews;



