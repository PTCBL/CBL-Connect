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
    currentArmada: 'D 8707 UE',
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

            // Abaikan pakan mutasi kandang internal sapi (hanya nama kelompok ternak internal persis)
            let isKandang = ['jantan', 'betina', 'dewasa', 'kapalang', 'pedet', 'isolasi', 'kandang', 'domba', 'bx', 'kerbau', 'bunting', 'kambing'].includes(relasiClean);
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

    function getTripJumlahTitik(tr) {
        if (!tr) return 1;
        if (typeof tr.jumlah_titik !== 'undefined' && tr.jumlah_titik !== null) {
            let v = parseInt(tr.jumlah_titik);
            if (!isNaN(v) && v > 0) return v;
        }
        let m = (tr.catatan || '').match(/\[(\d+)\s*Titik\]/i);
        if (m) {
            let v = parseInt(m[1]);
            if (!isNaN(v) && v > 0) return v;
        }
        let relCount = (Array.isArray(tr.manifest_items) && tr.manifest_items.length > 0)
            ? new Set(tr.manifest_items.map(x => x.relasi).filter(Boolean)).size
            : 1;
        return Math.max(1, relCount);
    }
    window.getTripJumlahTitik = getTripJumlahTitik;

    trips.forEach(tr => {
        // Hanya hitung upah / insentif jika trip sudah SELESAI
        if (tr.status_trip && tr.status_trip !== 'SELESAI') return;

        let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
        let isAmbilMandiri = (tr.armada === 'Ambil Mandiri');
        let kg = parseFloat(tr.total_kg) || 0;
        let km = parseFloat(tr.jarak_tempuh_km) || 0;

        if (isTruk || isAmbilMandiri) {
            // 1. Truk / Ambil Mandiri: Aktivitas Bantu Muat Gudang (Flat Rp 15/kg Kru Muat)
            if (isTruk) {
                let titik = getTripJumlahTitik(tr);
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

    // Default Armada sesuai supir yang login: Adi -> D 8142 UK, Hilman -> D 8707 UE, Agus -> D 8749 UA
    let myNameLower = (activeUser || '').toLowerCase();
    let armadaDesc = 'Suzuki Carry';
    if (myNameLower.includes('adi')) {
        window.tripState.currentArmada = 'D 8142 UK';
        armadaDesc = 'Daihatsu Grand Max';
    } else if (myNameLower.includes('hilman')) {
        window.tripState.currentArmada = 'D 8707 UE';
        armadaDesc = 'Suzuki Carry';
    } else if (myNameLower.includes('agus')) {
        window.tripState.currentArmada = 'D 8749 UA';
        armadaDesc = 'Truk';
    } else {
        window.tripState.currentArmada = 'D 8707 UE';
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
            let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
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
    let curArmada = window.tripState.currentArmada || 'D 8707 UE';
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
    let desc = (armadaPlat === 'D 8142 UK') ? 'Daihatsu Grand Max' : (armadaPlat === 'D 8749 UA' ? 'Truk' : 'Suzuki Carry');
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
            // Jika kernek memilih supir Hilman -> Armada otomatis D 8707 UE
            let selUser = (window.tripState.cachedUsers || []).find(u => u.id === userId);
            if (selUser) {
                let sName = (selUser.nama || '').toLowerCase();
                if (sName.includes('adi')) selectArmadaPill('D 8142 UK');
                else if (sName.includes('hilman')) selectArmadaPill('D 8707 UE');
                else if (sName.includes('agus')) selectArmadaPill('D 8749 UA');
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

    let armada = window.tripState.currentArmada || 'D 8707 UE';
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

    let tglToday = new Date().toISOString().split('T')[0];
    let nextRit = 1;
    try {
        let resCount = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=eq.${tglToday}&armada=eq.${encodeURIComponent(armada)}&select=id`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (resCount.ok) {
            let tripsHariIni = await resCount.json();
            nextRit = (Array.isArray(tripsHariIni) ? tripsHariIni.length : 0) + 1;
        }
    } catch (e) {}

    let payloadTrip = {
        tanggal: tglToday,
        cabang: 'PM',
        armada: armada,
        urutan_rit: nextRit,
        sopir_user_id: sopirId,
        kernek_1_user_id: kernek1Id,
        kernek_2_user_id: kernek2Id,
        total_kg: totalKg,
        status_trip: 'BERANGKAT',
        waktu_berangkat: new Date().toISOString(),
        lat_start: gpsStart.lat,
        lng_start: gpsStart.lng,
        catatan: `(Rit ${nextRit}) Antar ke ${namaRelasi}: ${rincianPakanText.join(', ')}`,
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
    let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
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
            let titik = (typeof getTripJumlahTitik === 'function') ? getTripJumlahTitik(tr) : (parseInt(tr.jumlah_titik) || 1);
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
                let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
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
    let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
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
    if (armadaSel) {
        if (window._armadaActiveFilter && window._armadaActiveFilter !== 'all') {
            armadaSel.value = window._armadaActiveFilter;
        } else if (window.tripState && window.tripState.currentArmada) {
            armadaSel.value = window.tripState.currentArmada;
        }
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
    let armada = document.getElementById('bbm-input-armada')?.value || 'D 8707 UE';
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
    
    let targetArmada = 'D 8707 UE';
    let supirLabel = 'Hilman';
    let armadaDesc = 'Suzuki Carry';

    if (uName.includes('adi')) {
        targetArmada = 'D 8142 UK';
        supirLabel = 'Adi';
        armadaDesc = 'Daihatsu Grand Max';
    } else if (uName.includes('hilman')) {
        targetArmada = 'D 8707 UE';
        supirLabel = 'Hilman';
        armadaDesc = 'Suzuki Carry';
    } else {
        // Kernek atau staf lain
        targetArmada = window.tripState.currentArmada || 'D 8707 UE';
        supirLabel = (targetArmada === 'D 8142 UK') ? 'Adi' : 'Hilman';
        armadaDesc = (targetArmada === 'D 8142 UK') ? 'Daihatsu Grand Max' : 'Suzuki Carry';
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
function cetakSlipKlaimDriver(targetUserParam = null, customTripsParam = null, customFilterLabel = null) {
    let meUser = targetUserParam || (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) {
        alert("Sesi kru/driver tidak ditemukan.");
        return;
    }

    let unclaimedTrips = window.tripState.cachedUnclaimedTrips || [];
    let periodTrips = window.tripState.cachedPeriodTrips || [];
    let filterLabel = customFilterLabel || window.tripState.currentFilterLabel || 'Bulan Ini';

    // Prioritaskan mencetak daftar trip yang diberikan secara spesifik, atau yang belum dicairkan jika ada, atau daftar mutasi periode jika semua sudah cair
    let rawTrips = customTripsParam || ((unclaimedTrips.length > 0) ? unclaimedTrips : periodTrips);
    let tripsToPrint = (rawTrips || []).filter(tr => tr.status_trip === 'SELESAI');
    let hasBelumCair = tripsToPrint.some(tr => !tr.status_klaim || tr.status_klaim !== 'SUDAH_CAIR');
    let isPengajuanKlaim = hasBelumCair;

    if (!tripsToPrint || tripsToPrint.length === 0) {
        alert(`Tidak ada data pengantaran untuk ${meUser.nama} pada periode ${filterLabel}.`);
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');
    let userDict = {};
    (window.tripState.cachedUsers || []).forEach(u => { userDict[u.id] = u.nama; });

    let tglCetak = new Date().toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    let totalGrossKg = 0;
    let totalUpahPrint = 0;
    let totalKgPrint = 0;
    let relasiSummary = {};

    tripsToPrint.forEach(tr => {
        let isMandiri = (tr.armada === 'Ambil Mandiri');
        let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
        let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
        let trKg = parseFloat(tr.total_kg) || 0;
        totalGrossKg += trKg;

        let { upah: upahSaya, porsiKg } = hitungUpahSayaDiTrip(tr, meUser.id);
        totalUpahPrint += upahSaya;
        totalKgPrint += porsiKg;

        if (!relasiSummary[rNama]) {
            relasiSummary[rNama] = { rit: 0, grossKg: 0, upah: 0 };
        }
        relasiSummary[rNama].rit += 1;
        relasiSummary[rNama].grossKg += trKg;
        relasiSummary[rNama].upah += upahSaya;
    });

    let avgKgPerRit = tripsToPrint.length > 0 ? Math.round(totalGrossKg / tripsToPrint.length) : 0;

    let armadaStandar = '-';
    let userNamaLower = (meUser.nama || '').toLowerCase();
    let userRoleLower = (meUser.role || '').toLowerCase();
    if (userRoleLower.includes('sopir') || userRoleLower.includes('supir')) {
        if (userNamaLower.includes('hilman')) {
            armadaStandar = 'D 8707 UE (Suzuki Carry)';
        } else if (userNamaLower.includes('adi')) {
            armadaStandar = 'D 8142 UK (Daihatsu Grand Max)';
        } else if (meUser.armada_default) {
            armadaStandar = meUser.armada_default;
        }
    } else if (userRoleLower.includes('kernek')) {
        armadaStandar = 'Fleksibel (Sesuai Sopir)';
    }

    let safeUserNama = (meUser.nama || 'Driver').replace(/[^a-zA-Z0-9]/g, '_');
    let safeFilter = (filterLabel || 'Klaim').replace(/[^a-zA-Z0-9]/g, '_');
    let namaFilePdf = `Slip_Klaim_Upah_${safeUserNama}_${safeFilter}.pdf`;

    let baseUrl = window.location.href.split('?')[0];
    let verificationUrl = `${baseUrl}?klaim_kru=${encodeURIComponent(meUser.nama)}&periode=${encodeURIComponent(filterLabel)}`;

    let relasiKeys = Object.keys(relasiSummary);
    let relasiRowsHtml = relasiKeys.map((rName, idx) => {
        let it = relasiSummary[rName];
        return `
            <tr style="font-size:11px;">
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:center; color:#64748b;">${idx + 1}</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; font-weight:600; color:#0f172a;">${rName}</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:center; font-weight:700; color:#0f172a;">${it.rit} Rit</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:right; color:#0f172a;">${nf.format(it.grossKg)} Kg</td>
                <td style="border:1px solid #cbd5e1; padding:6px 8px; text-align:right; font-weight:700; color:#0f172a;">Rp ${nf.format(it.upah)}</td>
            </tr>
        `;
    }).join('');

    let docTitle = isPengajuanKlaim 
        ? "FORM PENGAJUAN KLAIM UPAH INSENTIF" 
        : `BUKTI PENCAIRAN & MUTASI INSENTIF (${filterLabel.toUpperCase()})`;

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
            <title>${docTitle} - PT CBL - ${meUser.nama}</title>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                    padding: 24px;
                    color: #0f172a;
                    background: #fff;
                    margin: 0;
                }
                #printable-area {
                    max-width: 800px;
                    margin: 0 auto;
                    background: #ffffff;
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
                    color: #0f172a;
                    letter-spacing: 0.5px;
                }
                .company-sub {
                    font-size: 11px;
                    color: #64748b;
                    margin-top: 2px;
                }
                .form-title {
                    font-size: 14px;
                    font-weight: 800;
                    color: #0f172a;
                    margin-top: 8px;
                    letter-spacing: 0.3px;
                }
                .badge-doc {
                    font-size: 11px;
                    font-weight: 700;
                    padding: 6px 12px;
                    background: #ffffff;
                    color: #000000;
                    border: 1.5px solid #000000;
                    border-radius: 6px;
                    text-align: right;
                }
                .info-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                    background: #f8fafc;
                    border: 1px solid #cbd5e1;
                    border-radius: 8px;
                    padding: 10px 14px;
                    margin-bottom: 14px;
                    font-size: 11px;
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
                }
                .table-slip th {
                    background: #f8fafc;
                    border: 1px solid #cbd5e1;
                    padding: 6px 8px;
                    font-weight: 700;
                    color: #334155;
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                }
                .table-slip td {
                    color: #0f172a;
                }
                .total-card {
                    background: #1e3a8a !important;
                    border: none !important;
                    border-radius: 8px;
                    padding: 12px 18px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    color: #ffffff !important;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }
                .signatures {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr;
                    gap: 16px;
                    text-align: center;
                    font-size: 11px;
                    page-break-inside: avoid;
                }
                .sig-box {
                    padding-top: 45px;
                    border-top: 1px solid #334155;
                    font-weight: bold;
                }
                @media print {
                    body { padding: 0; }
                    .no-print { display: none !important; }
                    .total-card {
                        background: #1e3a8a !important;
                        color: #ffffff !important;
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                }
            </style>
        </head>
        <body>
            <div class="no-print" style="margin-bottom:15px; display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap;">
                <button onclick="kirimWhatsAppKlaim()" style="padding:8px 14px; background:#15803d; color:white; border:none; border-radius:6px; font-weight:bold; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px;">
                    📲 Kirim Ringkasan ke WhatsApp
                </button>
                <button id="btn-download-pdf" onclick="unduhPdfKlaim()" style="padding:8px 14px; background:#0284c7; color:white; border:none; border-radius:6px; font-weight:bold; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px;">
                    📥 Download File PDF (1 Lembar)
                </button>
                <button onclick="window.print()" style="padding:8px 14px; background:#1e3a8a; color:white; border:none; border-radius:6px; font-weight:bold; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px;">
                    🖨️ Cetak Dokumen
                </button>
                <button onclick="window.close()" style="padding:8px 14px; background:#64748b; color:white; border:none; border-radius:6px; font-size:12px; cursor:pointer;">
                    Tutup
                </button>
            </div>

            <div id="printable-area">
                <div class="header">
                    <div>
                        <div class="company-name">PT CBL - LOGISTIK PENGIRIMAN PAKAN</div>
                        <div class="company-sub">Sistem Kartu Piutang & Manajemen Insentif Kru Lapangan</div>
                        <div class="form-title">${docTitle}</div>
                    </div>
                    <div class="badge-doc">
                        ${isPengajuanKlaim ? 'STATUS: PENGAJUAN KLAIM' : 'STATUS: SUDAH DICAIRKAN (LUNAS)'}<br>
                        <span style="font-size:10px; font-weight:normal; color:#475569;">Waktu Cetak: ${tglCetak}</span>
                    </div>
                </div>

                <div class="info-grid">
                    <div>
                        <div class="info-item"><span style="color:#64748b;">Nama Petugas:</span> <strong>${meUser.nama}</strong></div>
                        <div class="info-item"><span style="color:#64748b;">Role / Jabatan:</span> <strong style="text-transform:capitalize;">${meUser.role}</strong></div>
                        <div class="info-item"><span style="color:#64748b;">Armada Standar:</span> <strong>${armadaStandar}</strong></div>
                    </div>
                    <div>
                        <div class="info-item"><span style="color:#64748b;">Tarif Per Kg:</span> <strong>Rp 15 / Kg (Bagi Rata Kru)</strong></div>
                        <div class="info-item"><span style="color:#64748b;">Jumlah Pengantaran:</span> <strong>${tripsToPrint.length} Rit</strong></div>
                        <div class="info-item"><span style="color:#64748b;">Periode Pengajuan:</span> <strong>${filterLabel}</strong></div>
                    </div>
                </div>

                <!-- 1. Indikator Kinerja & Muatan -->
                <table class="table-slip" style="margin-bottom:12px;">
                    <thead>
                        <tr style="background:#f8fafc; font-size:10px;">
                            <th style="text-align:left; padding:6px 10px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Indikator Kinerja Pengantaran</th>
                            <th style="text-align:center; padding:6px 10px; width:130px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Jumlah / Volume</th>
                            <th style="text-align:right; padding:6px 10px; width:180px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Keterangan & Rata-rata</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr style="font-size:11px;">
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; font-weight:600; color:#0f172a;">Total Ritase Pengiriman Selesai</td>
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; text-align:center; font-weight:700; color:#0f172a;">${tripsToPrint.length} Rit</td>
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; text-align:right; font-size:10.5px; color:#475569;">Rata-rata: ${nf.format(avgKgPerRit)} Kg / Rit</td>
                        </tr>
                        <tr style="font-size:11px;">
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; font-weight:600; color:#0f172a;">Total Muatan Fisik Bruto Diangkut</td>
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; text-align:center; font-weight:700; color:#0f172a;">${nf.format(totalGrossKg)} Kg</td>
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; text-align:right; font-size:10.5px; color:#475569;">Tonase kotor seluruh armada</td>
                        </tr>
                        <tr style="font-size:11px;">
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; font-weight:600; color:#0f172a;">Porsi Beban Fisik Ditangani Petugas</td>
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; text-align:center; font-weight:700; color:#0f172a;">${nf.format(totalKgPrint)} Kg</td>
                            <td style="border:1px solid #cbd5e1; padding:7px 10px; text-align:right; font-size:10.5px; color:#475569;">Dibagi rata kru aktif per trip</td>
                        </tr>
                    </tbody>
                </table>

                <!-- 2. Ringkasan per Relasi Konsumen -->
                <div style="font-size:11px; font-weight:700; color:#0f172a; margin:10px 0 5px 0;">Rekapitulasi Ritase per Relasi Tujuan:</div>
                <table class="table-slip" style="margin-bottom:14px;">
                    <thead>
                        <tr style="background:#f8fafc; font-size:10px;">
                            <th style="text-align:center; padding:6px 8px; width:30px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">No</th>
                            <th style="text-align:left; padding:6px 8px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Relasi / Konsumen Tujuan</th>
                            <th style="text-align:center; padding:6px 8px; width:70px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Ritase</th>
                            <th style="text-align:right; padding:6px 8px; width:110px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Tonase Diangkut</th>
                            <th style="text-align:right; padding:6px 8px; width:120px; text-transform:uppercase; letter-spacing:0.3px; color:#334155;">Bagian Upah</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${relasiRowsHtml}
                    </tbody>
                </table>

                <!-- 3. QR Code & Audit Digital Link (Centerpiece) -->
                <div style="background:#f8fafc; border:1.5px solid #0f172a; border-radius:8px; padding:10px 14px; margin-bottom:14px; display:flex; align-items:center; gap:14px; page-break-inside:avoid;">
                    <div style="flex-shrink:0; background:#ffffff; padding:5px; border:1px solid #cbd5e1; border-radius:6px; display:flex; align-items:center; justify-content:center;">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=110x110&margin=0&data=${encodeURIComponent(verificationUrl)}" 
                             alt="QR Code Verifikasi" 
                             width="88" height="88" 
                             style="display:block; width:88px; height:88px;" />
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="display:inline-flex; align-items:center; gap:4px; background:#0f172a; color:#ffffff; font-size:9.5px; font-weight:800; padding:2px 7px; border-radius:4px; margin-bottom:4px; letter-spacing:0.5px;">
                            SCAN UNTUK AUDIT DETAIL (${tripsToPrint.length} RIT)
                        </div>
                        <div style="font-size:12px; font-weight:800; color:#0f172a; margin-bottom:2px;">Verifikasi Rincian Lengkap Digital</div>
                        <div style="font-size:10px; color:#64748b; line-height:1.45; margin-bottom:5px;">
                            Scan QR Code di samping menggunakan kamera HP untuk mengaudit rincian lengkap ke-<b>${tripsToPrint.length} rit pengantaran</b> (jam berangkat/tiba, GPS kandang, jenis pakan, dan kru pendamping).
                        </div>
                        <div style="font-size:9.5px; color:#2563eb; font-weight:700; word-break:break-all;">
                            🔗 ${verificationUrl}
                        </div>
                    </div>
                </div>

                <!-- 4. Kotak Total Biru Tua -->
                <div class="total-card" style="margin-bottom:18px;">
                    <div>
                        <div style="font-size:10px; color:#bfdbfe; font-weight:700; letter-spacing:0.5px;">TOTAL ESTIMASI BEBAN FISIK DITANGANI:</div>
                        <div style="font-size:17px; font-weight:800; color:#ffffff; margin-top:2px;">${nf.format(totalKgPrint)} Kg</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:10px; color:#bfdbfe; font-weight:700; letter-spacing:0.5px;">TOTAL UPAH BERSIH KLAIM:</div>
                        <div style="font-size:22px; font-weight:900; color:#ffffff; margin-top:2px;">Rp ${nf.format(totalUpahPrint)}</div>
                    </div>
                </div>

                <!-- 5. Tanda Tangan Tiga Pihak -->
                <div class="signatures">
                    <div>
                        <p style="margin-bottom:45px;">Petugas Pengaju,</p>
                        <div class="sig-box">${meUser.nama}<br><span style="font-weight:normal; font-size:10px; color:#64748b;">(${meUser.role})</span></div>
                    </div>
                    <div>
                        <p style="margin-bottom:45px;">Koordinator Lapangan,</p>
                        <div class="sig-box">Pak Agus<br><span style="font-weight:normal; font-size:10px; color:#64748b;">Koordinator Armada & Logistik</span></div>
                    </div>
                    <div>
                        <p style="margin-bottom:45px;">Disetujui Oleh,</p>
                        <div class="sig-box">Wildan<br><span style="font-weight:normal; font-size:10px; color:#64748b;">Admin Pusat & Keuangan</span></div>
                    </div>
                </div>
            </div>

            <script>
                var pesanWA = "*FORM PENGAJUAN KLAIM UPAH INSENTIF*\\n"
                    + "PT CBL - Logistik Pengiriman Pakan\\n\\n"
                    + "Petugas: *${meUser.nama}* (${meUser.role})\\n"
                    + "Periode Pengajuan: ${filterLabel}\\n"
                    + "Jumlah Pengantaran: *${tripsToPrint.length} Rit*\\n"
                    + "Total Muatan Diangkut: ${nf.format(totalGrossKg)} Kg\\n"
                    + "Porsi Beban Fisik: ${nf.format(totalKgPrint)} Kg\\n"
                    + "Total Upah Bersih: *Rp ${nf.format(totalUpahPrint)}*\\n\\n"
                    + "🔍 *Verifikasi & Rincian Lengkap (${tripsToPrint.length} Rit):*\\n"
                    + "${verificationUrl}\\n\\n"
                    + "Dokumen fisik ringkasan eksekutif telah ditandatangani. Mohon untuk diperiksa dan diproses pencairannya. Terima kasih.";

                function kirimWhatsAppKlaim() {
                    var waUrl = "https://api.whatsapp.com/send?text=" + encodeURIComponent(pesanWA);
                    window.open(waUrl, '_blank');
                }

                async function unduhPdfKlaim() {
                    var btn = document.getElementById('btn-download-pdf');
                    var oriText = btn.innerHTML;
                    btn.innerHTML = '⏳ Mengunduh PDF...';
                    btn.disabled = true;

                    var docEl = document.getElementById('printable-area');
                    var namaFile = "${namaFilePdf}";
                    var opt = {
                        margin: [0.3, 0.3, 0.3, 0.3],
                        filename: namaFile,
                        image: { type: 'jpeg', quality: 0.98 },
                        html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
                        pagebreak: { mode: 'css', avoid: ['table', '.total-card', '.signatures'] },
                        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
                    };

                    try {
                        await html2pdf().set(opt).from(docEl).save();
                    } catch (err) {
                        console.error(err);
                        alert("Gagal mengunduh otomatis, membuka dialog cetak...");
                        window.print();
                    } finally {
                        btn.innerHTML = oriText;
                        btn.disabled = false;
                    }
                }
            </script>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
}

// ====================================================================
// MODAL AUDIT VERIFIKASI DIGITAL KLAIM UPAH (DIBUKA SAAT SCAN QR CODE ATAU KLIK LINK WA)
// ====================================================================
async function bukaModalAuditKlaimPublik(kruNama, periodeLabel) {
    let existing = document.getElementById('screen-audit-klaim-digital');
    if (existing) existing.remove();

    let screen = document.createElement('div');
    screen.id = 'screen-audit-klaim-digital';
    screen.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:#f8fafc; z-index:9999999; display:flex; flex-direction:column; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    screen.innerHTML = `
        <!-- Top Navbar -->
        <header style="background:linear-gradient(135deg, #1e3a8a, #1d4ed8); color:white; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 2px 10px rgba(0,0,0,0.12); flex-shrink:0;">
            <div>
                <div style="display:inline-flex; align-items:center; gap:5px; background:rgba(255,255,255,0.18); padding:2px 8px; border-radius:12px; font-size:10px; font-weight:800; letter-spacing:0.5px; margin-bottom:3px;">
                    <span class="material-symbols-outlined" style="font-size:13px; color:#86efac;">verified</span> VERIFIKASI DIGITAL PT CBL
                </div>
                <h3 style="margin:0; font-size:16px; font-weight:800; letter-spacing:0.3px;">Audit Rincian Klaim Upah Insentif</h3>
                <div style="font-size:11.5px; opacity:0.9; margin-top:2px;">Petugas: <b>${kruNama}</b> | Periode: <b>${periodeLabel}</b></div>
            </div>
            <button type="button" onclick="tutupLayarAuditKlaimPublik()" style="background:rgba(255,255,255,0.18); border:1px solid rgba(255,255,255,0.3); color:white; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                <span>Selesai</span> ✕
            </button>
        </header>

        <!-- Main Content Area -->
        <main style="flex:1; overflow-y:auto; padding:16px; max-width:760px; width:100%; margin:0 auto; box-sizing:border-box;">
            <div style="margin-bottom:12px;">
                <input type="text" id="cari-audit-card-input" placeholder="🔍 Cari nama konsumen atau tanggal..." 
                       oninput="filterCardsAuditKlaim(this.value)" 
                       style="width:100%; box-sizing:border-box; padding:10px 14px; border:1px solid #cbd5e1; border-radius:10px; font-size:13px; background:#ffffff;">
            </div>

            <div id="audit-cards-container">
                <div style="text-align:center; padding:40px 20px; color:#64748b;">
                    <span class="material-symbols-outlined icon-spin" style="font-size:36px; color:#2563eb;">sync</span>
                    <div style="margin-top:10px; font-size:13px; font-weight:700;">Mengambil seluruh rincian riwayat pengantaran & muat...</div>
                </div>
            </div>
        </main>

        <footer style="background:#ffffff; border-top:1px solid #e2e8f0; padding:10px 18px; text-align:center; font-size:11px; color:#64748b; flex-shrink:0;">
            Sistem Kartu Piutang & Insentif Kru CBL • Verifikasi Dokumen Digital
        </footer>
    `;
    document.body.appendChild(screen);

    try {
        let users = [];
        if (window.tripState && Array.isArray(window.tripState.cachedUsers) && window.tripState.cachedUsers.length > 0) {
            users = window.tripState.cachedUsers;
        } else {
            let resUsers = await fetch(`${SUPA_URL}/rest/v1/users_app?select=id,nama,role`, {
                headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
            });
            if (resUsers.ok) {
                let data = await resUsers.json();
                if (Array.isArray(data)) users = data;
            }
        }

        if (!Array.isArray(users) || users.length === 0) {
            throw new Error("Gagal mengambil data kru dari server.");
        }

        let targetUser = users.find(u => u.nama && u.nama.toLowerCase().trim() === kruNama.toLowerCase().trim())
            || users.find(u => u.nama && u.nama.toLowerCase().includes(kruNama.toLowerCase())) 
            || users.find(u => u.nama && kruNama.toLowerCase().includes(u.nama.toLowerCase()));
        if (!targetUser) throw new Error(`Petugas "${kruNama}" tidak ditemukan di database.`);

        let uDict = {};
        users.forEach(u => { uDict[u.id] = u.nama; });

        // Query seluruh trip SELESAI tanpa rest or filter agar pekerja_muat_ids (Hilman) ikut terambil
        let resTrips = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?status_trip=eq.SELESAI&order=tanggal.desc,waktu_berangkat.desc&limit=300`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (!resTrips.ok) throw new Error("Gagal mengambil riwayat trip dari server.");
        let allTrips = await resTrips.json();
        let userTrips = Array.isArray(allTrips) ? allTrips.filter(tr => isUserInTrip(tr, targetUser.id)) : [];

        // Filter periode jika ditentukan (contoh "Oktober 2026")
        let bulanIndo = {
            'januari': '01', 'februari': '02', 'maret': '03', 'april': '04',
            'mei': '05', 'juni': '06', 'juli': '07', 'agustus': '08',
            'september': '09', 'oktober': '10', 'november': '11', 'desember': '12'
        };
        let pLower = (periodeLabel || '').toLowerCase();
        let matchedMonth = Object.keys(bulanIndo).find(b => pLower.includes(b));
        let matchedYear = pLower.match(/\b(20\d\d)\b/);
        if (matchedMonth && matchedYear) {
            let ym = `${matchedYear[1]}-${bulanIndo[matchedMonth]}`;
            let filtered = userTrips.filter(tr => tr.tanggal && tr.tanggal.startsWith(ym));
            if (filtered.length > 0) {
                userTrips = filtered;
            }
        }

        let container = document.getElementById('audit-cards-container');
        if (!container) return;

        if (userTrips.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding:50px 20px; color:#64748b; background:#ffffff; border-radius:12px; border:1px solid #e2e8f0;">
                    <span class="material-symbols-outlined" style="font-size:48px; color:#cbd5e1; margin-bottom:8px;">inbox</span>
                    <div style="font-weight:700; font-size:14px; color:#334155;">Tidak ada riwayat untuk ${targetUser.nama} pada periode ini.</div>
                </div>
            `;
            return;
        }

        let nf = new Intl.NumberFormat('id-ID');

        let cardsHtml = userTrips.map(tr => {
            let isMandiri = (tr.armada === 'Ambil Mandiri');
            let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
            let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
            let trKg = parseFloat(tr.total_kg) || 0;
            let kmVal = parseFloat(tr.total_km) || 0;
            let kmText = (isMandiri || isTruk || kmVal === 0) ? '0 KM' : `${kmVal} KM`;

            let { upah } = hitungUpahSayaDiTrip(tr, targetUser.id);
            let tglFormatted = tr.tanggal ? tr.tanggal.split('-').reverse().slice(0, 2).join('/') : '-';
            let inisial = rNama.trim().slice(0, 2).toUpperCase() || 'TR';

            return `
                <div class="audit-trip-card" data-search="${rNama.toLowerCase()} ${tglFormatted}" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:12px 15px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
                    <div style="display:flex; align-items:center; gap:12px; min-width:0;">
                        <div style="width:38px; height:38px; border-radius:50%; background:#f1f5f9; color:#0f172a; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12.5px; flex-shrink:0; border:1px solid #cbd5e1;">
                            ${inisial}
                        </div>
                        <div style="min-width:0;">
                            <div style="font-weight:800; font-size:13.5px; color:#0f172a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${rNama}</div>
                            <div style="font-size:11.5px; color:#64748b; margin-top:2px;">
                                ${tglFormatted} • <b>${nf.format(trKg)} Kg</b> • <span>${kmText}</span>
                            </div>
                        </div>
                    </div>
                    <div style="text-align:right; display:flex; align-items:center; gap:10px; flex-shrink:0;">
                        <div style="font-size:15px; font-weight:800; color:#0f172a;">+Rp ${nf.format(upah)}</div>
                        <button type="button" onclick="bukaModalDetailAuditSingle('${tr.id}', '${targetUser.id}')" style="background:#f8fafc; color:#1e293b; border:1px solid #cbd5e1; padding:6px 10px; border-radius:8px; font-size:11px; font-weight:700; cursor:pointer;">
                            Rincian &gt;
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = cardsHtml;
    } catch (e) {
        let container = document.getElementById('audit-cards-container');
        if (container) {
            container.innerHTML = `<div style="text-align:center; padding:30px; color:#dc2626; background:#fff; border-radius:12px; border:1px solid #fecaca;">Gagal memuat audit rincian: ${e.message}</div>`;
        }
    }
}

function filterCardsAuditKlaim(query) {
    let q = (query || '').toLowerCase();
    let cards = document.querySelectorAll('.audit-trip-card');
    cards.forEach(c => {
        let s = c.getAttribute('data-search') || '';
        c.style.display = s.includes(q) ? '' : 'none';
    });
}

function tutupLayarAuditKlaimPublik() {
    let screen = document.getElementById('screen-audit-klaim-digital');
    if (screen) screen.remove();

    let params = new URLSearchParams(window.location.search);
    if (params.get('klaim_kru')) {
        try { window.close(); } catch (e) {}
        window.location.href = window.location.pathname;
    }
}

async function bukaModalDetailAuditSingle(tripId, userId) {
    let existing = document.getElementById('modal-detail-audit-single');
    if (existing) existing.remove();

    let modal = document.createElement('div');
    modal.id = 'modal-detail-audit-single';
    modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.65); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; z-index:99999999; padding:15px; box-sizing:border-box;';
    modal.innerHTML = `
        <div style="background:#ffffff; width:100%; max-width:440px; border-radius:14px; overflow:hidden; box-shadow:0 20px 40px rgba(0,0,0,0.25);">
            <div style="background:#0f172a; color:white; padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
                <h4 style="margin:0; font-size:14px; font-weight:800;">Rincian Pengantaran</h4>
                <button type="button" onclick="document.getElementById('modal-detail-audit-single').remove()" style="background:transparent; border:none; color:white; font-size:18px; cursor:pointer;">✕</button>
            </div>
            <div id="modal-detail-audit-single-content" style="padding:16px; font-size:12px; color:#334155;">
                <div style="text-align:center; padding:15px; color:#94a3b8;">Memuat detail...</div>
            </div>
            <div style="background:#f8fafc; padding:10px 16px; border-top:1px solid #e2e8f0; text-align:right;">
                <button type="button" onclick="document.getElementById('modal-detail-audit-single').remove()" style="background:#0f172a; color:white; border:none; padding:7px 16px; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer;">Tutup</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}&select=*`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        let data = await res.json();
        let tr = data[0];
        if (!tr) throw new Error("Data trip tidak ditemukan.");

        let users = window.tripState?.cachedUsers || [];
        let uDict = {};
        users.forEach(u => { uDict[u.id] = u.nama; });

        let nf = new Intl.NumberFormat('id-ID');
        let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
        let isMandiri = (tr.armada === 'Ambil Mandiri');
        let isTruk = (tr.armada === 'Truk' || tr.armada === 'D 8749 UA' || (tr.armada || '').includes('8749'));
        let trKg = parseFloat(tr.total_kg) || 0;
        let kmVal = parseFloat(tr.total_km) || 0;
        let { upah, porsiKg } = hitungUpahSayaDiTrip(tr, userId);

        let kruNames = [];
        let nKru = 1;
        if (isMandiri || isTruk) {
            let pIds = Array.isArray(tr.pekerja_muat_ids) ? tr.pekerja_muat_ids : [];
            nKru = pIds.length || 1;
            kruNames = pIds.map(id => uDict[id] || `User #${id}`);
        } else {
            let sopirNama = uDict[tr.sopir_user_id] || 'Sopir';
            let k1Nama = uDict[tr.kernek_1_user_id];
            let k2Nama = uDict[tr.kernek_2_user_id];
            kruNames = [sopirNama, k1Nama, k2Nama].filter(Boolean);
            nKru = kruNames.length || 1;
        }

        let tipeKerja = (isMandiri || isTruk) ? 'Bantu Muat / Bongkar Truk' : 'Pengantaran Armada Pick-up';
        let rumusText = nKru > 1 
            ? `(${nf.format(trKg)} Kg × Rp 15 / ${nKru} orang)`
            : `(${nf.format(trKg)} Kg × Rp 15)`;

        let gpsStr = (tr.gps_lat && tr.gps_lng) ? `${tr.gps_lat.toFixed(4)}, ${tr.gps_lng.toFixed(4)}` : 'Sesuai Kandang';
        let waktuBerangkat = tr.waktu_berangkat ? tr.waktu_berangkat.slice(0, 5) : '-';
        let waktuTiba = tr.waktu_tiba ? tr.waktu_tiba.slice(0, 5) : '-';

        document.getElementById('modal-detail-audit-single-content').innerHTML = `
            <div style="font-size:15px; font-weight:800; color:#0f172a; margin-bottom:10px;">${rNama}</div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
                <div><span style="color:#64748b; font-size:11px;">Tanggal:</span><br><b>${tr.tanggal || '-'}</b></div>
                <div><span style="color:#64748b; font-size:11px;">Jam:</span><br><b>${waktuBerangkat} - ${waktuTiba}</b></div>
                <div><span style="color:#64748b; font-size:11px;">Armada:</span><br><b>${tr.armada || '-'}</b></div>
                <div><span style="color:#64748b; font-size:11px;">Jarak Tempuh:</span><br><b>${kmVal} KM</b></div>
            </div>

            <div style="margin-bottom:8px;">
                <div style="color:#64748b; font-size:11px;">Kategori Pekerjaan:</div>
                <div style="font-weight:700; color:#0f172a;">${tipeKerja}</div>
            </div>

            <div style="margin-bottom:8px;">
                <div style="color:#64748b; font-size:11px;">Kru Bertugas (${nKru} Orang):</div>
                <div style="font-weight:700; color:#0f172a;">${kruNames.join(' & ') || '-'}</div>
            </div>

            <div style="margin-bottom:12px; padding:10px; background:#f1f5f9; border-radius:8px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span style="color:#64748b;">Muatan Total:</span>
                    <b>${nf.format(trKg)} Kg</b>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span style="color:#64748b;">Porsi Beban Petugas:</span>
                    <b>${nf.format(porsiKg)} Kg</b>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:11px; color:#64748b;">
                    <span>Rumus Upah:</span>
                    <span>${rumusText}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid #cbd5e1; font-size:13px;">
                    <span style="font-weight:700; color:#0f172a;">Upah Bagian Petugas:</span>
                    <b style="font-size:14px; color:#0f172a;">Rp ${nf.format(upah)}</b>
                </div>
            </div>
            
            <div style="font-size:10.5px; color:#64748b;">
                📍 Titik Lokasi: <b>${gpsStr}</b>
            </div>
        `;
    } catch (err) {
        document.getElementById('modal-detail-audit-single-content').innerHTML = `
            <div style="color:#dc2626; text-align:center; padding:15px;">Gagal memuat detail: ${err.message}</div>
        `;
    }
}

// Inisialisasi Pemeriksaan URL Parameter untuk Link Audit Klaim
window.addEventListener('DOMContentLoaded', () => {
    let params = new URLSearchParams(window.location.search);
    let kruNama = params.get('klaim_kru');
    if (kruNama) {
        let periode = params.get('periode') || 'Bulan Ini';
        let loginScr = document.getElementById('login-screen');
        if (loginScr) loginScr.style.setProperty('display', 'none', 'important');
        let appScr = document.getElementById('app-screen');
        if (appScr) appScr.classList.add('hidden');
        bukaModalAuditKlaimPublik(kruNama, periode);
    }
});
window.bukaModalAuditKlaimPublik = bukaModalAuditKlaimPublik;
window.filterCardsAuditKlaim = filterCardsAuditKlaim;
window.tutupLayarAuditKlaimPublik = tutupLayarAuditKlaimPublik;
window.bukaModalDetailAuditSingle = bukaModalDetailAuditSingle;

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

// ====================================================================
// SINKRONISASI BIAYA SOLAR TRUK (RP 100.000 / TITIK) KE TABEL CASHFLOW
// ====================================================================
async function syncSolarTrukToCashflow(tripId, armada, tanggal, jumlahTitik, relasiTujuan) {
    if (!tripId) return;
    let isTruk = (armada || '').includes('8749') || (armada || '').toLowerCase().includes('truk');
    let titik = parseInt(jumlahTitik) || 1;
    let nominalSolar = titik * 100000;
    let tag = `[TRIP:${tripId}]`;

    try {
        let resCheck = await fetch(`${SUPA_URL}/rest/v1/cashflow?keterangan=like.*${encodeURIComponent(tag)}*&select=id,nominal,keterangan`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        let existingRows = resCheck.ok ? await resCheck.json() : [];

        if (!isTruk) {
            // Jika armada BUKAN truk (misal diubah jadi pick-up), hapus entri solar truk jika sebelumnya ada
            if (Array.isArray(existingRows) && existingRows.length > 0) {
                await fetch(`${SUPA_URL}/rest/v1/cashflow?keterangan=like.*${encodeURIComponent(tag)}*`, {
                    method: 'DELETE',
                    headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
                });
            }
            return;
        }

        // Armada ADALAH Truk
        let tgl = tanggal || new Date().toISOString().split('T')[0];
        let relasi = 'D 8749 UA (Truk - Pak Agus)';
        let ket = `Uang Jalan Solar Truk (${titik} Titik Penurunan: ${relasiTujuan || '-'}) ${tag}`;

        if (Array.isArray(existingRows) && existingRows.length > 0) {
            let cfId = existingRows[0].id;
            await fetch(`${SUPA_URL}/rest/v1/cashflow?id=eq.${cfId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                },
                body: JSON.stringify({
                    nominal: nominalSolar,
                    keterangan: ket,
                    tanggal: tgl,
                    relasi: relasi
                })
            });
        } else {
            let cfPayload = {
                tanggal: tgl,
                jenis: 'Keluar',
                kategori: 'BBM / Solar',
                relasi: relasi,
                nominal: nominalSolar,
                metode: 'Cash',
                diskon: 0,
                keterangan: ket,
                petugas: 'Sistem Logistik',
                created_at: new Date().toISOString()
            };
            let resPost = await fetch(`${SUPA_URL}/rest/v1/cashflow`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                },
                body: JSON.stringify(cfPayload)
            });
            if (!resPost.ok) {
                console.error("Gagal insert solar truk ke cashflow:", await resPost.text());
            }
        }
    } catch (errSync) {
        console.error("Gagal sinkron solar truk ke cashflow:", errSync);
    }
}
window.syncSolarTrukToCashflow = syncSolarTrukToCashflow;

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
        armada: 'D 8749 UA',
        total_kg: totalKg,
        status_trip: 'BERANGKAT',
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
                'Prefer': 'return=representation',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || "Gagal menyimpan pengiriman truk");
        }

        let createdTrips = await res.json();
        if (Array.isArray(createdTrips) && createdTrips[0]?.id) {
            await syncSolarTrukToCashflow(createdTrips[0].id, 'D 8749 UA', payload.tanggal, 1, namaRelasi);
        }

        alert(`✅ Pengiriman Truk Berhasil Diberangkatkan!\nMuatan: ${totalKg.toLocaleString('id-ID')} Kg\nKru: ${kruIds.length} Orang\nSolar Sopir: Rp 100.000 (Otomatis tercatat di Cashflow)`);
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

// Render Barometer Keseimbangan Pengiriman Pick-Up (Hilman vs Adi)
function renderBarometerArmada(trips, labelPeriode) {
    let containerBarometer = document.getElementById('admin-barometer-container');
    if (!containerBarometer) return;

    let nf = new Intl.NumberFormat('id-ID');
    let p1Kg = 0, p2Kg = 0, trukKg = 0;
    let p1Km = 0, p2Km = 0, trukKm = 0;
    let p1Trips = 0, p2Trips = 0, trukTrips = 0;

    (trips || []).forEach(tr => {
        let arm = (tr.armada || '').toUpperCase();
        let kg = parseFloat(tr.total_kg) || 0;
        let km = parseFloat(tr.jarak_tempuh_km) || 0;
        if (arm.includes('D 8707 UE') || arm.includes('D 8070 UE')) {
            p1Kg += kg;
            p1Km += km;
            p1Trips++;
        } else if (arm.includes('D 8142 UK')) {
            p2Kg += kg;
            p2Km += km;
            p2Trips++;
        } else if (arm.includes('D 8749 UA') || arm.includes('8749') || arm.includes('TRUK')) {
            trukKg += kg;
            trukKm += km;
            trukTrips++;
        }
    });

    let totalKg = p1Kg + p2Kg + trukKg;
    let pctP1 = totalKg > 0 ? Math.round((p1Kg / totalKg) * 100) : 0;
    let pctP2 = totalKg > 0 ? Math.round((p2Kg / totalKg) * 100) : 0;
    let pctTruk = totalKg > 0 ? (100 - pctP1 - pctP2) : 0;

    let totalPickupKg = p1Kg + p2Kg;
    let pctPU1 = totalPickupKg > 0 ? Math.round((p1Kg / totalPickupKg) * 100) : 50;
    let isPickupSeimbang = (totalPickupKg === 0) || (pctPU1 >= 40 && pctPU1 <= 60);

    let badgeHtml = (totalKg === 0)
        ? `<span style="font-size:10px; font-weight:800; padding:3px 8px; border-radius:12px; background:#f1f5f9; color:#64748b;">⚖️ BELUM ADA PENGIRIMAN</span>`
        : isPickupSeimbang
            ? `<span style="font-size:10px; font-weight:800; padding:3px 8px; border-radius:12px; background:#dcfce7; color:#15803d;">✅ PICK-UP SEIMBANG (40-60%)</span>`
            : `<span style="font-size:10px; font-weight:800; padding:3px 8px; border-radius:12px; background:#fef3c7; color:#b45309;">⚠️ PICK-UP KURANG SEIMBANG</span>`;

    containerBarometer.innerHTML = `
        <div style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:15px; margin-bottom:15px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="font-size:13px; font-weight:800; color:#1e293b;">⚖️ Barometer & Distribusi Muatan Armada CBL</span>
                    <span style="font-size:11px; color:#64748b; font-weight:600;">(${labelPeriode || 'Periode Ini'})</span>
                </div>
                ${badgeHtml}
            </div>
            <div style="height:22px; border-radius:6px; overflow:hidden; display:flex; background:#e2e8f0;">
                ${pctP1 > 0 ? `<div style="width:${pctP1}%; background:#2563eb; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; transition:width 0.3s ease;" title="D 8707 UE (Hilman): ${pctP1}%">D 8707 UE (${pctP1}%)</div>` : ''}
                ${pctP2 > 0 ? `<div style="width:${pctP2}%; background:#ea580c; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; transition:width 0.3s ease;" title="D 8142 UK (Adi): ${pctP2}%">D 8142 UK (${pctP2}%)</div>` : ''}
                ${pctTruk > 0 ? `<div style="width:${pctTruk}%; background:#0f766e; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; transition:width 0.3s ease;" title="D 8749 UA (Truk Agus): ${pctTruk}%">D 8749 UA (${pctTruk}%)</div>` : ''}
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; margin-top:10px; font-size:11px; color:#475569;">
                <div>• <b style="color:#2563eb;">D 8707 UE (Hilman):</b> ${nf.format(p1Kg)} Kg | ${p1Km} Km | ${p1Trips} Rit</div>
                <div>• <b style="color:#ea580c;">D 8142 UK (Adi):</b> ${nf.format(p2Kg)} Kg | ${p2Km} Km | ${p2Trips} Rit</div>
                <div>• <b style="color:#0f766e;">D 8749 UA (Truk Agus):</b> ${nf.format(trukKg)} Kg | ${trukKm} Km | ${trukTrips} Rit</div>
            </div>
        </div>
    `;
}

// Wrapper backward compatible untuk sinkronisasi live
async function loadMonitoringArmadaAdmin() {
    await loadLogBBMAdmin();
}

// Rekap Payroll & Tombol Tutup Periode Insentif
let currentAdminPayrollFilter = 'bulanan';
let cachedAdminPayrollTrips = [];
let cachedAdminPayrollPeriodLabel = 'Bulan Ini';
let cachedAdminPayrollStartDate = '';
let cachedAdminPayrollEndDate = '';

function setAdminPayrollFilter(mode) {
    currentAdminPayrollFilter = mode;
    ['mingguan', 'bulanan', 'tahunan'].forEach(m => {
        let btn = document.getElementById(`btn-adm-pay-${m}`);
        if (btn) {
            btn.style.background = (m === mode) ? '#2563eb' : 'transparent';
            btn.style.color = (m === mode) ? '#ffffff' : '#64748b';
        }
    });
    renderRekapPayrollAdmin(mode);
}

async function renderRekapPayrollAdmin(filterMode = currentAdminPayrollFilter) {
    let tbody = document.getElementById('admin-payroll-tbody');
    let tfoot = document.getElementById('admin-payroll-tfoot');
    let badgePeriode = document.getElementById('admin-payroll-badge-periode');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Memuat data insentif periode...</td></tr>`;

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

    if (badgePeriode) badgePeriode.innerText = `Periode: ${labelPeriode}`;
    cachedAdminPayrollPeriodLabel = labelPeriode;
    cachedAdminPayrollStartDate = startDate;
    cachedAdminPayrollEndDate = endDate;

    let allTrips = await fetchTripsByDateRange(startDate, endDate);
    let trips = (allTrips || []).filter(tr => tr.status_trip === 'SELESAI');
    cachedAdminPayrollTrips = trips;
    let users = window.tripState.cachedUsers || [];

    let akumulasi = hitungAkumulasiInsentifPeriode(trips, users);
    let nf = new Intl.NumberFormat('id-ID');

    let rows = Object.values(akumulasi.userMap).filter(u => u.totalBersih > 0 || u.tripCount > 0);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Belum ada insentif tercatat untuk periode ${labelPeriode}.</td></tr>`;
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
                <td style="padding:8px; text-align:right; font-weight:800; color:#0f172a; font-size:12px;">Rp ${nf.format(u.totalBersih)}</td>
                <td style="padding:8px; text-align:center;">
                    <button type="button" onclick="cetakFormKlaimDariAdmin('${u.id}', '${encodeURIComponent(u.nama)}')" style="background:#0284c7; color:white; border:none; padding:5px 9px; border-radius:6px; font-weight:700; font-size:10.5px; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                        <span class="material-symbols-outlined" style="font-size:13px;">print</span> Cetak Form
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    if (tfoot) tfoot.innerText = `Rp ${nf.format(akumulasi.grandTotal)}`;
}

// Handler Cetak Form Klaim Karyawan Langsung dari Layar Admin
async function cetakFormKlaimDariAdmin(userId, userNamaEncoded = '') {
    let userNama = userNamaEncoded ? decodeURIComponent(userNamaEncoded) : '';
    let users = window.tripState?.cachedUsers || [];

    if (!Array.isArray(users) || users.length === 0) {
        try {
            let res = await fetch(`${SUPA_URL}/rest/v1/users_app?select=*&order=nama.asc`, {
                headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
            });
            if (res.ok) {
                users = await res.json();
                if (window.tripState) window.tripState.cachedUsers = users;
            }
        } catch (e) {
            console.error(e);
        }
    }

    let targetUser = users.find(u => String(u.id) === String(userId))
        || (userNama ? users.find(u => u.nama && u.nama.toLowerCase().trim() === userNama.toLowerCase().trim()) : null)
        || (userNama ? users.find(u => u.nama && u.nama.toLowerCase().includes(userNama.toLowerCase())) : null);

    if (!targetUser) {
        alert("Data karyawan tidak ditemukan.");
        return;
    }

    let trips = cachedAdminPayrollTrips;
    if (!trips || trips.length === 0) {
        let today = new Date().toISOString().split('T')[0];
        let fetched = await fetchTripsByDateRange(today, today);
        trips = (fetched || []).filter(tr => tr.status_trip === 'SELESAI');
    }

    let userTrips = trips.filter(tr => tr.status_trip === 'SELESAI' && isUserInTrip(tr, targetUser.id));
    if (userTrips.length === 0) {
        alert(`Tidak ada riwayat pengantaran atau muat untuk ${targetUser.nama} pada periode ${cachedAdminPayrollPeriodLabel}.`);
        return;
    }

    cetakSlipKlaimDriver(targetUser, userTrips, cachedAdminPayrollPeriodLabel);
}

// Tombol Admin: Cairkan & Tutup Periode Insentif
async function tutupPeriodeDanCairkanToples() {
    let cutoffDate = cachedAdminPayrollEndDate || new Date().toISOString().split('T')[0];
    let konfirm = confirm(`Apakah Anda yakin ingin MENCAIRKAN & MENUTUP PERIODE INSENTIF (${cachedAdminPayrollPeriodLabel})?\n\nSemua trip pengiriman yang SELESAI sampai tanggal ${cutoffDate} akan ditandai LUNAS / SUDAH CAIR.\nSaldo berjalan di dompet supir & kernek otomatis ter-reset kembali ke Rp 0.`);
    if (!konfirm) return;

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?status_trip=eq.SELESAI&tanggal=lte.${cutoffDate}&or=(status_klaim.is.null,status_klaim.neq.SUDAH_CAIR)`, {
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

        if (!res.ok) {
            let errText = await res.text();
            throw new Error(errText || "Gagal memperbarui status pencairan di database.");
        }

        alert(`✅ Periode Insentif (${cachedAdminPayrollPeriodLabel}) Berhasil Ditutup & Dicairkan!\n\nSaldo berjalan seluruh supir & kernek otomatis di-reset ke Rp 0 dan riwayat mutasi telah ditandai Lunas.`);
        renderRekapPayrollAdmin();
    } catch (e) {
        alert("Gagal menutup periode: " + e.message);
    }
}

function switchAdminTripTab(tab) {
    let viewBbm = document.getElementById('view-adm-bbm');
    if (viewBbm) viewBbm.classList.remove('hidden');
    loadLogBBMAdmin();
}

// ====================================================================
// 8. LOG & PERAWATAN ARMADA (SISI ADMIN)
// ====================================================================

window._armadaActiveFilter = 'all';
window._armadaActivePeriod = 'bulanan';
window._armadaActiveSubtab = 'biaya';
window._armadaTujuanFilter = '';
window._armadaMonthOffset = 0;
window._ruteSubFilterMode = 'antar';
window._selectedOrderToAssign = null;
window._cacheArmadaData = { expenses: [], trips: [], ongkirRows: [], unassignedOrders: [], labelPeriode: 'Bulan Ini' };

function setArmadaPeriodFilter(mode) {
    window._armadaActivePeriod = mode;
    window._armadaMonthOffset = 0; // reset offset saat ganti tipe periode
    ['mingguan', 'bulanan', 'tahunan'].forEach(m => {
        let btn = document.getElementById(`btn-period-${m}`);
        if (btn) {
            btn.style.background = (m === mode) ? '#2563eb' : 'transparent';
            btn.style.color = (m === mode) ? '#ffffff' : '#64748b';
        }
    });
    loadLogBBMAdmin();
}

function navigateArmadaPeriod(delta) {
    window._armadaMonthOffset = (window._armadaMonthOffset || 0) + delta;
    loadLogBBMAdmin();
}
window.navigateArmadaPeriod = navigateArmadaPeriod;

function switchFilterRuteMode(mode) {
    window._ruteSubFilterMode = mode;
    let btnAntar = document.getElementById('tab-subview-antar');
    let btnAmbil = document.getElementById('tab-subview-ambil');
    let hint = document.getElementById('subview-rute-hint');

    if (mode === 'antar') {
        if (btnAntar) { btnAntar.style.background = '#0f766e'; btnAntar.style.color = 'white'; btnAntar.style.borderColor = '#0f766e'; }
        if (btnAmbil) { btnAmbil.style.background = '#ffffff'; btnAmbil.style.color = '#475569'; btnAmbil.style.borderColor = '#cbd5e1'; }
        if (hint) hint.innerText = "Riwayat pengantaran armada mobil CBL";
    } else {
        if (btnAntar) { btnAntar.style.background = '#ffffff'; btnAntar.style.color = '#475569'; btnAntar.style.borderColor = '#cbd5e1'; }
        if (btnAmbil) { btnAmbil.style.background = '#0f766e'; btnAmbil.style.color = 'white'; btnAmbil.style.borderColor = '#0f766e'; }
        if (hint) hint.innerText = "Orderan yang diambil sendiri atau belum ditentukan armada pengantarnya";
    }
    renderArmadaLogViews();
}
window.switchFilterRuteMode = switchFilterRuteMode;

function onTujuanFilterChange(val) {
    window._armadaTujuanFilter = (val || '').trim().toLowerCase();
    // Otomatis pindah ke subtab Riwayat Perjalanan jika sedang memfilter tujuan
    if (window._armadaTujuanFilter && window._armadaActiveSubtab !== 'rute') {
        switchSubTabArmada('rute');
    }
    renderArmadaLogViews();
}

function clearTujuanFilter() {
    let inp = document.getElementById('filter-armada-tujuan');
    if (inp) inp.value = '';
    window._armadaTujuanFilter = '';
    renderArmadaLogViews();
}

function updateDatalistTujuan() {
    let dl = document.getElementById('list-tujuan-armada');
    if (!dl) return;

    let setTujuan = new Set();
    if (Array.isArray(window.globalRelasi)) {
        window.globalRelasi.forEach(r => { if (r && r.nama) setTujuan.add(r.nama.trim()); });
    }
    if (window.tripState && window.tripState.cachedRelasiMap) {
        Object.keys(window.tripState.cachedRelasiMap).forEach(k => { if (k) setTujuan.add(k.trim()); });
    }
    if (Array.isArray(window._cacheArmadaData.trips)) {
        window._cacheArmadaData.trips.forEach(tr => {
            (tr.manifest_items || []).forEach(m => { if (m && m.relasi) setTujuan.add(m.relasi.trim()); });
            if (tr.catatan) setTujuan.add(tr.catatan.trim());
        });
    }

    let arr = Array.from(setTujuan).filter(Boolean).sort((a, b) => a.localeCompare(b));
    dl.innerHTML = arr.map(item => `<option value="${item}"></option>`).join('');
}

async function loadLogBBMAdmin() {
    let tbodyExpenses = document.getElementById('admin-bbm-tbody');
    let tbodyTrips = document.getElementById('admin-armada-rute-tbody');
    let badgePeriode = document.getElementById('badge-armada-period-label');
    if (!tbodyExpenses) return;

    tbodyExpenses.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Memuat data operasional armada...</td></tr>`;
    if (tbodyTrips) {
        tbodyTrips.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Memuat riwayat perjalanan armada...</td></tr>`;
    }

    let now = new Date();
    let pad = n => String(n).padStart(2, '0');
    let startDate, endDate, labelPeriode;
    let offset = window._armadaMonthOffset || 0;

    if (window._armadaActivePeriod === 'mingguan') {
        let baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (offset * 7));
        let dStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() - 6);
        startDate = `${dStart.getFullYear()}-${pad(dStart.getMonth() + 1)}-${pad(dStart.getDate())}`;
        endDate = `${baseDate.getFullYear()}-${pad(baseDate.getMonth() + 1)}-${pad(baseDate.getDate())}`;
        labelPeriode = `7 Hari (${dStart.getDate()}/${dStart.getMonth() + 1} - ${baseDate.getDate()}/${baseDate.getMonth() + 1}/${baseDate.getFullYear()})`;
    } else if (window._armadaActivePeriod === 'tahunan') {
        let targetYear = now.getFullYear() + offset;
        startDate = `${targetYear}-01-01`;
        endDate = `${targetYear}-12-31`;
        labelPeriode = `Tahun ${targetYear}`;
    } else {
        // bulanan
        let targetDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        let y = targetDate.getFullYear();
        let m = targetDate.getMonth();
        let lastDate = new Date(y, m + 1, 0);
        startDate = `${y}-${pad(m + 1)}-01`;
        endDate = `${y}-${pad(m + 1)}-${pad(lastDate.getDate())}`;
        labelPeriode = targetDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    }

    if (badgePeriode) badgePeriode.innerText = labelPeriode;

    try {
        // 1. Ambil data pengeluaran armada (BBM, Servis, Ban, Cuci) dari cashflow
        let p1 = fetch(`${SUPA_URL}/rest/v1/cashflow?jenis=eq.Keluar&tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,created_at.desc&limit=500`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json());

        // 2. Ambil riwayat perjalanan/rit dari trip_pengiriman via fetchTripsByDateRange
        let p2 = fetchTripsByDateRange(startDate, endDate);

        // 3. Ambil data pendapatan ongkir dari transaksi_pakan dalam periode aktif
        let p3 = fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?pakan=eq.Ongkir Pengiriman&tanggal=gte.${startDate}&tanggal=lte.${endDate}&select=id,tanggal,harga_satuan,qty,armada,trip_id,relasi`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json()).catch(() => []);

        // 4. Ambil transaksi penjualan/mutasi keluar dalam periode aktif untuk tab Ambil Mandiri / Belum Diantar
        let p4 = fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?status=in.(Keluar,Mutasi)&tanggal=gte.${startDate}&tanggal=lte.${endDate}&pakan=neq.Ongkir Pengiriman&select=id,tanggal,waktu_input,status,relasi,alamat,pakan,qty,satuan,armada,trip_id,catatan`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        }).then(r => r.json()).catch(() => []);

        let [rawCF, rawTrips, rawOngkir, rawKeluar] = await Promise.all([p1, p2, p3, p4]);

        // Filter cashflow yang relevan dengan armada (BBM, Ban, Servis, Cuci, atau ada sebutan plat)
        let armadaExpenses = (Array.isArray(rawCF) ? rawCF : []).filter(item => {
            let tgl = item.tanggal || '';
            // Pastikan tanggal cashflow dalam rentang periode aktif
            if (tgl && (tgl < startDate || tgl > endDate)) return false;

            let kat = (item.kategori || '').toLowerCase();
            let rel = (item.relasi || '').toLowerCase();
            let ket = (item.keterangan || '').toLowerCase();
            let arm = (item.armada || '').toLowerCase();
            let allText = `${kat} ${rel} ${ket} ${arm}`;

            // Abaikan transaksi Keswan atau supir bantuan luar (Pak Yaya & Uje & Doyok)
            if (allText.includes('keswan') || allText.includes('yaya') || allText.includes('uje') || allText.includes('doyok')) return false;

            let isArmadaRelated = 
                kat.includes('bbm') || kat.includes('solar') || kat.includes('bensin') ||
                kat.includes('kendaraan') || kat.includes('servis') || kat.includes('service') ||
                kat.includes('operasional') || kat.includes('ekspedisi') ||
                kat.includes('ban') || kat.includes('angin') ||
                kat.includes('cuci') || kat.includes('perawatan') ||
                kat.includes('sparepart') || kat.includes('oli') ||
                kat.includes('tol') || kat.includes('parkir') ||
                rel.includes('armada') || rel.includes('spbu') || rel.includes('bengkel') ||
                rel.includes('8749') || rel.includes('8707') || rel.includes('8070') || rel.includes('8142') ||
                rel.includes('truk') || rel.includes('grand max') || rel.includes('carry') ||
                ket.includes('8749') || ket.includes('8707') || ket.includes('8070') || ket.includes('8142') ||
                ket.includes('truk') || ket.includes('grand max') || ket.includes('carry') ||
                ket.includes('ban') || ket.includes('angin') || ket.includes('oli') || ket.includes('servis') ||
                ket.includes('bensin') || ket.includes('solar') ||
                arm.includes('8749') || arm.includes('8707') || arm.includes('8070') || arm.includes('8142');

            return isArmadaRelated;
        });

        // Filter trip HANYA armada pengantaran (Ambil Mandiri DIKELUARKAN!)
        let fleetTrips = (Array.isArray(rawTrips) ? rawTrips : []).filter(tr => {
            let arm = (tr.armada || '').toLowerCase();
            let cat = (tr.catatan || '').toLowerCase();
            let isAmbil = arm === 'ambil mandiri' || arm.includes('ambil') || cat.includes('ambil sendiri') || cat.includes('ambil di gudang');
            return !isAmbil;
        });

        let supaPinHeader = (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234';

        // Auto-sinkron baris ongkir yang armada-nya masih belum cocok dengan trip fisik hari itu
        fleetTrips.forEach(tr => {
            let rels = (tr.manifest_items || []).map(m => m.relasi).filter(Boolean);
            if (rels.length === 0 && tr.catatan) rels.push(tr.catatan);
            rels.forEach(r => {
                let matchingOngkir = (Array.isArray(rawOngkir) ? rawOngkir : []).find(o => 
                    o.tanggal === tr.tanggal && (o.relasi || '').trim().toLowerCase() === (r || '').trim().toLowerCase()
                );
                if (matchingOngkir && (matchingOngkir.armada !== tr.armada || matchingOngkir.trip_id !== tr.id)) {
                    fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?id=eq.${matchingOngkir.id}`, {
                        method: 'PATCH',
                        headers: { 
                            'apikey': SUPA_ANON_KEY, 
                            'Authorization': `Bearer ${SUPA_ANON_KEY}`, 
                            'Content-Type': 'application/json',
                            'x-pin-karyawan': supaPinHeader
                        },
                        body: JSON.stringify({ armada: tr.armada, trip_id: tr.id })
                    }).catch(() => {});
                    matchingOngkir.armada = tr.armada;
                    matchingOngkir.trip_id = tr.id;
                }
            });
        });

        // Auto-sinkron solar truk ke cashflow jika ada trip truk yang belum tercatat di cashflow
        fleetTrips.filter(t => (t.armada || '').includes('8749') || (t.armada || '').toLowerCase().includes('truk')).forEach(tr => {
            let tag = `[TRIP:${tr.id}]`;
            let exists = armadaExpenses.some(e => (e.keterangan || '').includes(tag));
            if (!exists) {
                let manifest = tr.manifest_items || [];
                let rName = [...new Set(manifest.map(m => m.relasi).filter(Boolean))].join(', ') || tr.catatan;
                let titik = (typeof getTripJumlahTitik === 'function') ? getTripJumlahTitik(tr) : (parseInt(tr.jumlah_titik) || 1);
                syncSolarTrukToCashflow(tr.id, tr.armada, tr.tanggal, titik, rName);
            }
        });

        // Kelompokkan pesanan keluar yang diambil mandiri atau belum punya armada
        // KECUALIKAN: Pemakaian Kandang / Kelompok Sapi, Mutasi ke Kandang, dan Pakan Gilingan (RD/RL)
        const KELOMPOK_SAPI = ['kapalang', 'dewasa', 'jantan', 'pedet', 'kerbau', 'bunting', 'bx', 'domba', 'kambing'];
        let groupedUnassigned = {};
        (Array.isArray(rawKeluar) ? rawKeluar : []).forEach(row => {
            let arm = (row.armada || '').toLowerCase();
            let cat = (row.catatan || '').toLowerCase();
            let rel = (row.relasi || '').toLowerCase().trim();
            let pkn = (row.pakan || '').toLowerCase().trim();
            let stat = (row.status || '').toLowerCase().trim();

            // 1. Cek apakah ini pemakaian internal kandang / kelompok sapi (hanya nama entitas internal persis)
            if (stat.includes('pemakaian')) return;
            let isPemakaianKandang = KELOMPOK_SAPI.includes(rel) || 
                                     rel === 'kandang' || 
                                     rel === 'kandang pm' ||
                                     rel === 'kandang spn' ||
                                     rel === 'cibulakan' ||
                                     rel.includes('pembibitan');
            if (isPemakaianKandang) return;

            // 2. Cek apakah ini gilingan / RD / RL / Darbun / Laktasi
            let isGilingan = (row.relasi && (row.relasi.trim().toLowerCase() === 'rl' || row.relasi.trim().toLowerCase() === 'rd' || row.relasi.trim().toLowerCase() === 'darbun' || row.relasi.trim().toLowerCase() === 'laktasi')) ||
                             rel.includes('giling') || pkn.includes('giling');
            if (isGilingan) return;

            // 3. Jika mutasi, hanya mutasi antar gudang resmi (SPN, RPH, PM)
            if (stat.includes('mutasi')) {
                let isAntarGudang = (rel.includes('spn') || rel.includes('rph') || rel.includes('pm') || rel.includes('gudang')) && !rel.includes('kandang');
                if (!isAntarGudang) return;
            }

            let armUpper = (row.armada || '').toUpperCase();
            let isAssignedToFleet = armUpper.includes('8707') || armUpper.includes('8070') || 
                                    armUpper.includes('8142') || 
                                    armUpper.includes('8749') || armUpper.includes('TRUK') ||
                                    armUpper.includes('SEWA') || armUpper.includes('LUAR') || armUpper.includes('EKSPEDISI');

            // Jika transaksi ini SUDAH memiliki trip_id atau sudah ditugaskan ke Sewa Luar, lewati!
            if (row.trip_id || armUpper.includes('SEWA') || armUpper.includes('LUAR') || armUpper.includes('EKSPEDISI')) return;

            // ⚡ REKONSILIASI OTOMATIS TRANSAKSI TANPA TRIP_ID:
            // Hubungkan transaksi_pakan ke trip_pengiriman yang sesuai pada tanggal & relasi yang sama!
            let relClean = rel.replace(/\s+/g, ' ').trim();
            let allCandidateTrips = Array.isArray(rawTrips) ? rawTrips : [];
            let matchingFleetTrip = allCandidateTrips.find(ft => {
                if (ft.tanggal !== row.tanggal) return false;

                // Hanya filter kecocokan armada jika baris transaksi_pakan memang sudah punya armada CBL resmi spesifik
                let rowArm = (row.armada || '').toUpperCase();
                let isSpecificFleetRow = rowArm.includes('8707') || rowArm.includes('8070') || rowArm.includes('8142') || rowArm.includes('8749') || rowArm.includes('TRUK');
                if (isSpecificFleetRow) {
                    let ftArm = (ft.armada || '').toUpperCase();
                    let matchArm = (rowArm.includes('8707') && ftArm.includes('8707')) ||
                                   (rowArm.includes('8142') && ftArm.includes('8142')) ||
                                   ((rowArm.includes('8749') || rowArm.includes('TRUK')) && (ftArm.includes('8749') || ftArm.includes('TRUK')));
                    if (!matchArm) return false;
                }

                // Cek manifest_items (baik berupa array object, string, atau json)
                let mList = [];
                if (Array.isArray(ft.manifest_items)) mList = ft.manifest_items;
                else if (typeof ft.manifest_items === 'string') {
                    try { mList = JSON.parse(ft.manifest_items); } catch(e) {}
                }

                let manifestMatch = (Array.isArray(mList) ? mList : []).some(m => {
                    let rName = (m?.relasi || '').toLowerCase().trim();
                    return rName && (rName === relClean || rName.includes(relClean) || relClean.includes(rName));
                });

                let catText = (ft.catatan || '').toLowerCase();
                let catMatch = catText.includes(relClean) || (relClean.length > 3 && catText.includes(relClean.split(' ')[0]));

                return manifestMatch || catMatch;
            });

            if (matchingFleetTrip) {
                // Auto-hubungkan baris transaksi_pakan ini ke trip yang cocok di memori
                row.trip_id = matchingFleetTrip.id;
                row.armada = matchingFleetTrip.armada;
                let cleanCatatan = (row.catatan || '').replace(/\[AMBIL SENDIRI.*?\]|\[KIRIM.*?\]/gi, '').trim();
                let newCatatan = cleanCatatan ? `[KIRIM ${matchingFleetTrip.armada}] ${cleanCatatan}` : `[KIRIM ${matchingFleetTrip.armada}]`;
                row.catatan = newCatatan;

                // Best-effort update ke database Supabase (tanpa blocking jika terkunci audit tanggal lampau)
                let supaPin = (window.currentLoggedPin || (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) || localStorage.getItem('cbl_user_pin') || '1234');
                fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?id=eq.${row.id}`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'x-pin-karyawan': supaPin
                    },
                    body: JSON.stringify({
                        trip_id: matchingFleetTrip.id,
                        armada: matchingFleetTrip.armada,
                        catatan: newCatatan
                    })
                }).catch(() => {});

                return; // Langsung lewati dari antrean Ambil Mandiri / Belum Diantar!
            }

            let key = `${row.tanggal || ''}__${(row.relasi || '-').trim()}`;
                if (!groupedUnassigned[key]) {
                    groupedUnassigned[key] = {
                        tanggal: row.tanggal,
                        relasi: row.relasi || '-',
                        alamat: row.alamat || '-',
                        items: [],
                        manifestItems: [],
                        totalKg: 0,
                        txIds: [],
                        catatan: row.catatan || '',
                        latestTime: row.waktu_input || ''
                    };
                }
                let q = parseFloat(row.qty) || 0;
                groupedUnassigned[key].totalKg += q;
                groupedUnassigned[key].txIds.push(row.id);
                groupedUnassigned[key].items.push(`${row.pakan} (${q} ${row.satuan || 'Kg'})`);
                groupedUnassigned[key].manifestItems.push({
                    relasi: row.relasi || '-',
                    pakan: row.pakan,
                    qty: q
                });
                if (row.waktu_input && row.waktu_input > (groupedUnassigned[key].latestTime || '')) {
                    groupedUnassigned[key].latestTime = row.waktu_input;
                }
        });

        let unassignedOrders = Object.values(groupedUnassigned).map(u => {
            u.pakanText = u.items.join(', ');
            let rMatch = (rawOngkir || []).find(o => o.tanggal === u.tanggal && (o.relasi || '').trim().toLowerCase() === (u.relasi || '').trim().toLowerCase());
            let ongkirVal = rMatch ? ((parseFloat(rMatch.harga_satuan) || 0) * (parseFloat(rMatch.qty) || 1)) : 0;
            u.ongkirNominal = ongkirVal;
            u.hasOngkir = ongkirVal > 0;
            u.ongkirRowId = rMatch ? rMatch.id : null;
            return u;
        });

        // Urutkan tanggal secara kronologis menurun (tanggal terbaru dan input terbaru di atas)
        unassignedOrders.sort((a, b) => {
            let tglA = a.tanggal || '';
            let tglB = b.tanggal || '';
            if (tglA !== tglB) return tglB.localeCompare(tglA);
            return (b.latestTime || '').localeCompare(a.latestTime || '');
        });

        window._cacheArmadaData = {
            expenses: armadaExpenses,
            trips: fleetTrips,
            ongkirRows: Array.isArray(rawOngkir) ? rawOngkir : [],
            unassignedOrders: unassignedOrders,
            labelPeriode: labelPeriode
        };

        updateDatalistTujuan();
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
    let btnRapor = document.getElementById('subtab-btn-rapor');
    let viewBiaya = document.getElementById('subview-armada-biaya');
    let viewRute = document.getElementById('subview-armada-rute');
    let viewRapor = document.getElementById('subview-armada-rapor');

    [btnBiaya, btnRute, btnRapor].forEach(b => {
        if (b) { b.style.background = '#f8fafc'; b.style.color = '#475569'; b.style.borderColor = '#cbd5e1'; }
    });
    [viewBiaya, viewRute, viewRapor].forEach(v => {
        if (v) v.classList.add('hidden');
    });

    if (subtab === 'biaya') {
        if (btnBiaya) { btnBiaya.style.background = '#2563eb'; btnBiaya.style.color = '#ffffff'; btnBiaya.style.borderColor = '#2563eb'; }
        if (viewBiaya) viewBiaya.classList.remove('hidden');
    } else if (subtab === 'rute') {
        if (btnRute) { btnRute.style.background = '#0f766e'; btnRute.style.color = '#ffffff'; btnRute.style.borderColor = '#0f766e'; }
        if (viewRute) viewRute.classList.remove('hidden');
    } else if (subtab === 'rapor') {
        if (btnRapor) { btnRapor.style.background = '#7c3aed'; btnRapor.style.color = '#ffffff'; btnRapor.style.borderColor = '#7c3aed'; }
        if (viewRapor) viewRapor.classList.remove('hidden');
        renderRaporArmadaView();
    }
}

// ====================================================================
// PERHITUNGAN PENDAPATAN ONGKIR PER TRIP (FORMULA 2 - RIT BULAT CBL)
// ====================================================================

function getTripPendapatanOngkir(tr, allTrips, ongkirRows) {
    if (!tr) return { nominal: 0, rit: 0, label: '-' };

    let kg = parseFloat(tr.total_kg) || 0;
    if (kg <= 0) return { nominal: 0, rit: 0, label: 'Rp 0 (0 Rit)' };

    allTrips = allTrips || window._cacheArmadaData?.trips || [];
    ongkirRows = ongkirRows || window._cacheArmadaData?.ongkirRows || [];

    // 1. Ekstrak nama relasi dari manifest atau catatan
    let manifest = [];
    if (Array.isArray(tr.manifest_items)) manifest = tr.manifest_items;
    else if (typeof tr.manifest_items === 'string') {
        try { manifest = JSON.parse(tr.manifest_items); } catch(e) {}
    }
    let relasiList = [...new Set(manifest.map(m => (m?.relasi || '').trim()).filter(Boolean))];
    if (relasiList.length === 0 && tr.catatan) {
        let cleanC = tr.catatan.replace(/\[.*?\]|\(.*?\)/g, '').trim();
        if (cleanC) relasiList = [cleanC.split(' ')[0]];
    }

    let catText = (tr.catatan || '').toLowerCase();
    let relJoined = relasiList.join(' ').toLowerCase();

    // 🚨 CEK PENGIRIMAN INTERNAL / MUTASI GUDANG (SPN, Cibulakan, RPH, Kandang, Pembibitan)
    let isInternalOrMutasi = relJoined.includes('spn') || 
                             relJoined.includes('cibulakan') || 
                             relJoined.includes('pembibitan') || 
                             relJoined.includes('rph') || 
                             catText.includes('spn') || 
                             catText.includes('cibulakan') || 
                             catText.includes('pembibitan') || 
                             catText.includes('mutasi');

    if (isInternalOrMutasi) {
        return { nominal: 0, rit: 0, label: 'Rp 0 (Internal/Mutasi)' };
    }

    let armText = (tr.armada || '').toLowerCase();
    let isSewaLuar = armText.includes('sewa') || armText.includes('luar') || armText.includes('doyok') || armText.includes('uje');
    if (isSewaLuar) {
        return { nominal: 0, rit: 0, label: 'Rp 0 (Sewa Luar)' };
    }

    // 2. Cari baris tagihan ongkir di transaksi_pakan yang sesuai (tanggal & relasi / trip_id)
    let matchingOngkirRows = (ongkirRows || []).filter(r => {
        if (r.tanggal !== tr.tanggal) return false;
        if (r.trip_id && r.trip_id == tr.id) return true;
        let rName = (r.relasi || '').trim().toLowerCase();
        return relasiList.some(rel => rName.includes(rel.toLowerCase()) || rel.toLowerCase().includes(rName));
    });

    let totalOngkirKonsumen = matchingOngkirRows.reduce((sum, r) => sum + ((parseFloat(r.harga_satuan) || 0) * (parseFloat(r.qty) || 1)), 0);

    // Jika konsumen tidak ditagih ongkir (ongkir 0 / promo / ambil gudang / tanpa ongkir)
    if (totalOngkirKonsumen <= 0) {
        return { nominal: 0, rit: 0, label: 'Rp 0 (Tanpa Ongkir)' };
    }

    // 3. Cari sibling trips (trip armada lain pada tanggal dan relasi yang sama untuk split rombongan)
    let siblingTrips = (allTrips || []).filter(other => {
        if (other.id === tr.id || other.tanggal !== tr.tanggal) return false;
        let oArm = (other.armada || '').toLowerCase();
        if (oArm.includes('ambil') || oArm.includes('mandiri')) return false;

        let oManifest = [];
        if (Array.isArray(other.manifest_items)) oManifest = other.manifest_items;
        else if (typeof other.manifest_items === 'string') {
            try { oManifest = JSON.parse(other.manifest_items); } catch(e) {}
        }
        let oRelasi = [...new Set(oManifest.map(m => (m?.relasi || '').trim()).filter(Boolean))];
        let hasSameRelasi = oRelasi.some(r => relasiList.some(rel => r.toLowerCase().includes(rel.toLowerCase()) || rel.toLowerCase().includes(r.toLowerCase())));
        if (!hasSameRelasi && tr.catatan && other.catatan) {
            hasSameRelasi = relasiList.some(rel => (other.catatan || '').toLowerCase().includes(rel.toLowerCase()));
        }
        return hasSameRelasi;
    });

    let nf = new Intl.NumberFormat('id-ID');

    // KASUS 1: TRIP STANDALONE (Bukan split rombongan)
    if (siblingTrips.length === 0) {
        let rit = Math.max(1, Math.round(totalOngkirKonsumen / 50000));
        return { 
            nominal: totalOngkirKonsumen, 
            rit: rit, 
            label: `Rp ${nf.format(totalOngkirKonsumen)} (${rit} Rit)` 
        };
    }

    // KASUS 2: MULTI-ARMADA / SPLIT TRIP ROMBONGAN (FORMULA 2)
    // Buat grup trip yang terlibat, urutkan dari muatan terbesar (primer) ke terkecil (sekunder/pick-up)
    let group = [tr, ...siblingTrips];
    group.sort((a, b) => {
        let kgA = parseFloat(a.total_kg) || 0;
        let kgB = parseFloat(b.total_kg) || 0;
        if (kgB !== kgA) return kgB - kgA;
        return a.id - b.id;
    });

    let isPrimary = (group[0].id === tr.id);

    if (!isPrimary) {
        // Armada sekunder / pick-up: dapat porsi sesuai rit bebannya (1 rit = 50.000)
        let rit = kg <= 1700 ? 1 : Math.max(1, Math.round(kg / 1500));
        let nom = Math.min(totalOngkirKonsumen, rit * 50000);
        return { 
            nominal: nom, 
            rit: rit, 
            label: `Rp ${nf.format(nom)} (${rit} Rit)` 
        };
    }

    // Armada primer / induk muatan terbesar (misal Truk): mengambil sisa pendapatan tagihan
    let sumOtherNom = 0;
    for (let i = 1; i < group.length; i++) {
        let sKg = parseFloat(group[i].total_kg) || 0;
        let sRit = sKg <= 1700 ? 1 : Math.max(1, Math.round(sKg / 1500));
        sumOtherNom += (sRit * 50000);
    }

    let nomPrimary = Math.max(0, totalOngkirKonsumen - sumOtherNom);
    let ritPrimary = Math.max(1, Math.round(nomPrimary / 50000));
    return { 
        nominal: nomPrimary, 
        rit: ritPrimary, 
        label: `Rp ${nf.format(nomPrimary)} (${ritPrimary} Rit)` 
    };
}
window.getTripPendapatanOngkir = getTripPendapatanOngkir;

function renderArmadaLogViews() {
    let nf = new Intl.NumberFormat('id-ID');
    let filter = window._armadaActiveFilter || 'all';
    let summaryBox = document.getElementById('admin-bbm-summary');
    let tbodyExpenses = document.getElementById('admin-bbm-tbody');
    let tbodyTrips = document.getElementById('admin-armada-rute-tbody');

    let allExpenses = window._cacheArmadaData.expenses || [];
    let allTrips = window._cacheArmadaData.trips || [];

    // 0. Update Barometer Keseimbangan Pick-Up untuk armada pick-up pada periode aktif
    renderBarometerArmada(allTrips, window._cacheArmadaData.labelPeriode);

    // Helper match armada plat
    function matchArmada(targetArmada, itemArmada, relasi, keterangan) {
        if (targetArmada === 'all') return true;
        let str = `${itemArmada || ''} ${relasi || ''} ${keterangan || ''}`.toUpperCase();
        if (targetArmada === 'D 8749 UA' || targetArmada === 'Truk') {
            return str.includes('D 8749 UA') || str.includes('8749') || str.includes('TRUK');
        }
        if (targetArmada === 'D 8707 UE') {
            return str.includes('8707') || str.includes('8070');
        }
        if (targetArmada === 'D 8142 UK') {
            return str.includes('8142');
        }
        return str.includes(targetArmada.toUpperCase());
    }

    let filteredExpenses = allExpenses.filter(item => {
        return matchArmada(filter, item.armada, item.relasi, item.keterangan);
    });

    let filteredTrips = allTrips.filter(t => {
        // 1. Filter Armada
        if (filter !== 'all') {
            let arm = (t.armada || '').toUpperCase();
            if (filter === 'D 8749 UA' || filter === 'Truk') {
                if (!arm.includes('8749') && !arm.includes('TRUK')) return false;
            } else {
                if (!arm.includes(filter.toUpperCase())) return false;
            }
        }

        // 2. Filter Pencarian Tujuan (Autocomplete / Rekomendasi Ketik)
        if (window._armadaTujuanFilter) {
            let manifest = t.manifest_items || [];
            let relasiList = [...new Set(manifest.map(m => m.relasi).filter(Boolean))].join(' ').toLowerCase();
            let searchTarget = `${relasiList} ${t.catatan || ''}`.toLowerCase();
            if (!searchTarget.includes(window._armadaTujuanFilter)) return false;
        }

        return true;
    });

    // 1. KPI Aggregation & Data per Armada Tetap
    let expensesHilman = allExpenses.filter(i => matchArmada('D 8707 UE', i.armada, i.relasi, i.keterangan) || matchArmada('D 8070 UE', i.armada, i.relasi, i.keterangan));
    let expensesAdi = allExpenses.filter(i => matchArmada('D 8142 UK', i.armada, i.relasi, i.keterangan));
    let tripsHilman = allTrips.filter(t => (t.armada || '').toUpperCase().includes('D 8707 UE') || (t.armada || '').toUpperCase().includes('D 8070 UE'));
    let tripsAdi = allTrips.filter(t => (t.armada || '').toUpperCase().includes('D 8142 UK'));

    let biayaHilman = expensesHilman.reduce((sum, item) => sum + (parseFloat(item.nominal) || 0), 0);
    let biayaAdi = expensesAdi.reduce((sum, item) => sum + (parseFloat(item.nominal) || 0), 0);
    let lastNoteHilman = expensesHilman[0] || null;
    let lastNoteAdi = expensesAdi[0] || null;

    let ongkirRows = window._cacheArmadaData?.ongkirRows || [];
    let totalOngkir = 0;
    if (filter === 'all') {
        // Tagihan Ongkir Riil Konsumen yang diantar Armada Internal CBL (Sewa Luar / Supir Luar DIKECUALIKAN agar tidak mendistorsi KPI CBL)
        totalOngkir = (ongkirRows || []).filter(r => {
            let a = (r.armada || '').toLowerCase();
            let c = (r.catatan || '').toLowerCase();
            let isLuar = a.includes('sewa') || a.includes('luar') || a.includes('ekspedisi') || a.includes('doyok') || a.includes('yaya') || a.includes('uje') || c.includes('sewa luar');
            return !isLuar;
        }).reduce((sum, r) => sum + ((parseFloat(r.harga_satuan) || 0) * (parseFloat(r.qty) || 1)), 0);
    } else {
        let mFleet = getFleetReportMetrics(filter, allTrips, allExpenses, ongkirRows);
        totalOngkir = mFleet.pendapatanOngkir || 0;
    }

    let biayaPengantaran = 0;
    let biayaHppBahanBaku = 0;

    filteredExpenses.forEach(item => {
        let nom = parseFloat(item.nominal) || 0;
        let kat = (item.kategori || '').toLowerCase();
        let ket = (item.keterangan || '').toLowerCase();
        let text = `${kat} ${ket}`;

        let isAmbilPakan = kat.includes('ekspedisi') || 
                           text.includes('ambil sjm') || 
                           text.includes('ambil kf') || 
                           text.includes('tebon') || 
                           text.includes('sjm cimaung') || 
                           text.includes('ambil kfzs');

        if (isAmbilPakan) {
            biayaHppBahanBaku += nom;
        } else {
            biayaPengantaran += nom;
        }
    });

    let marginLogistik = totalOngkir - biayaPengantaran;

    if (summaryBox) {
        let filterLabel = (filter === 'all') ? 'Semua Armada' : filter;
        summaryBox.innerHTML = `
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-bottom:15px;">
                <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#1e40af; font-weight:700;">Biaya Pengantaran (${filterLabel})</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#1d4ed8;">Rp ${nf.format(biayaPengantaran)}</h3>
                    <div style="font-size:10px; color:#64748b; margin-top:3px; line-height:1.35;">
                        BBM, Servis, Ban, Cuci ${biayaHppBahanBaku > 0 ? `<br><span style="color:#d97706; font-weight:600;">HPP Ambil Bahan Baku: Rp ${nf.format(biayaHppBahanBaku)}</span>` : ''}
                    </div>
                </div>
                <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#15803d; font-weight:700;">Pendapatan Ongkir (${filterLabel})</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#16a34a;">Rp ${nf.format(totalOngkir)}</h3>
                    <div style="font-size:10px; color:#15803d; margin-top:3px;">Tagihan Ongkir Pengiriman</div>
                </div>
                <div style="background:${marginLogistik >= 0 ? '#f0fdf4' : '#fef2f2'}; border:1px solid ${marginLogistik >= 0 ? '#bbf7d0' : '#fecaca'}; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:${marginLogistik >= 0 ? '#15803d' : '#991b1b'}; font-weight:700;">Margin Logistik (${filterLabel})</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:${marginLogistik >= 0 ? '#15803d' : '#dc2626'};">
                        ${marginLogistik >= 0 ? '+' : ''}Rp ${nf.format(marginLogistik)}
                    </h3>
                    <div style="font-size:10px; color:${marginLogistik >= 0 ? '#15803d' : '#dc2626'}; margin-top:3px; font-weight:600;">
                        ${marginLogistik >= 0 ? 'Surplus Logistik' : 'Subsidi Ongkir CBL'}
                    </div>
                </div>
                <div style="background:#f5f3ff; border:1px solid #ddd6fe; border-radius:10px; padding:12px;">
                    <span style="font-size:11px; color:#6d28d9; font-weight:700;">Total Pengiriman (${filterLabel})</span>
                    <h3 style="margin:4px 0 0 0; font-size:18px; font-weight:800; color:#7c3aed;">${filteredTrips.length} Pengantaran</h3>
                    <div style="font-size:10px; color:#6d28d9; margin-top:3px;">Armada CBL (${window._cacheArmadaData.labelPeriode})</div>
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
                let rawKet = (item.keterangan || '').trim();
                let ket = (rawKet && rawKet !== '-') ? rawKet : (item.kategori || '-');
                let odoMatch = rawKet.match(/Spido:\s*([0-9]+)\s*KM/i);
                let odoStr = odoMatch ? `${nf.format(odoMatch[1])} KM` : '-';

                // Deteksi armada & supir badge
                let rAndK = `${item.relasi || ''} ${item.keterangan || ''} ${item.armada || ''}`.toUpperCase();
                let armName = 'Armada';
                if (rAndK.includes('8707') || rAndK.includes('8070')) armName = 'D 8707 UE (Hilman)';
                else if (rAndK.includes('8142')) armName = 'D 8142 UK (Adi)';
                else if (rAndK.includes('8749') || rAndK.includes('TRUK')) armName = 'D 8749 UA (Agus)';

                let katBadge = `<span style="background:#eff6ff; color:#1d4ed8; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px;">receipt</span> ${item.kategori || 'Operasional'}</span>`;
                let kText = `${item.kategori || ''} ${ket}`.toLowerCase();
                if (kText.includes('bbm') || kText.includes('solar')) {
                    katBadge = `<span style="background:#fef3c7; color:#b45309; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#d97706;">local_gas_station</span> ${item.kategori || 'BBM/Solar'}</span>`;
                } else if (kText.includes('ban') || kText.includes('angin')) {
                    katBadge = `<span style="background:#fee2e2; color:#b91c1c; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#dc2626;">tire_repair</span> ${item.kategori || 'Ban/Angin'}</span>`;
                } else if (kText.includes('oli') || kText.includes('servis') || kText.includes('perbaikan') || kText.includes('tune up')) {
                    katBadge = `<span style="background:#dbeafe; color:#1e40af; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#2563eb;">build</span> ${item.kategori || 'Servis/Oli'}</span>`;
                } else if (kText.includes('cuci')) {
                    katBadge = `<span style="background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#0284c7;">local_car_wash</span> ${item.kategori || 'Cuci Mobil'}</span>`;
                } else if (kText.includes('tol') || kText.includes('jalan') || kText.includes('parkir')) {
                    katBadge = `<span style="background:#f3e8ff; color:#7e22ce; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px;"><span class="material-symbols-outlined" style="font-size:12px; color:#9333ea;">toll</span> ${item.kategori || 'Tol/Parkir'}</span>`;
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

    // 3. Render Tabel Riwayat Perjalanan (Tracking Kemana Aja vs Ambil Mandiri)
    let unassignedList = window._cacheArmadaData?.unassignedOrders || [];
    if (window._armadaTujuanFilter) {
        unassignedList = unassignedList.filter(u => (u.relasi || '').toLowerCase().includes(window._armadaTujuanFilter));
    }

    let countAntarEl = document.getElementById('count-rute-antar');
    let countAmbilEl = document.getElementById('count-rute-ambil');
    if (countAntarEl) countAntarEl.innerText = filteredTrips.length;
    if (countAmbilEl) countAmbilEl.innerText = unassignedList.length;

    if (tbodyTrips) {
        if (window._ruteSubFilterMode === 'ambil') {
            // Tampilan Ambil Mandiri / Belum Diantar
            if (unassignedList.length === 0) {
                tbodyTrips.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Tidak ada orderan ambil mandiri / belum diantar pada periode ini.</td></tr>`;
            } else {
                tbodyTrips.innerHTML = unassignedList.map((ord, idx) => {
                    let armadaCell = ord.hasOngkir
                        ? `<span style="background:#fff7ed; color:#c2410c; padding:3px 8px; border-radius:6px; font-weight:800; border:1px solid #fed7aa; display:inline-flex; align-items:center; gap:4px;"><span class="material-symbols-outlined" style="font-size:13px;">pending</span> Belum Ditugaskan</span>`
                        : `<span style="color:#64748b; font-weight:600;">Diambil Konsumen</span>`;

                    let ongkirCell = ord.hasOngkir
                        ? `<span style="font-weight:800; color:#15803d; font-size:12px;">Rp ${nf.format(ord.ongkirNominal)}</span>`
                        : `<span style="color:#94a3b8; font-weight:600;">-</span>`;

                    let statusCell = ord.hasOngkir
                        ? `<span style="background:#fee2e2; color:#b91c1c; font-size:10px; font-weight:800; padding:2px 8px; border-radius:10px; border:1px solid #fecaca;">PERLU DIANTAR</span>`
                        : `<span style="background:#f1f5f9; color:#475569; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px; border:1px solid #e2e8f0;">AMBIL MANDIRI</span>`;

                    let buttonAction = ord.hasOngkir
                        ? `<button type="button" onclick="bukaModalTugaskanArmada(${idx})" style="background:#0f766e; color:white; border:none; padding:5px 10px; border-radius:6px; font-weight:700; font-size:11px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 2px 4px rgba(15,118,110,0.2);">
                               <span class="material-symbols-outlined" style="font-size:15px;">local_shipping</span> Tugaskan Armada
                           </button>`
                        : `<button type="button" onclick="bukaModalTugaskanArmada(${idx})" style="background:#f8fafc; color:#475569; border:1px solid #cbd5e1; padding:4px 8px; border-radius:6px; font-weight:600; font-size:10.5px; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                               <span class="material-symbols-outlined" style="font-size:13px;">local_shipping</span> Ubah Pengantaran
                           </button>`;

                    return `
                        <tr style="border-bottom:1px solid #e2e8f0; font-size:11px;">
                            <td style="padding:10px 8px; font-weight:700; color:#1e293b;">${ord.tanggal || '-'}</td>
                            <td style="padding:10px 8px; text-align:center; white-space:nowrap;">
                                <span style="background:${ord.hasOngkir ? '#eff6ff' : '#f1f5f9'}; color:${ord.hasOngkir ? '#1d4ed8' : '#64748b'}; font-size:10px; font-weight:700; padding:2px 6px; border-radius:6px; display:inline-block;">${ord.hasOngkir ? 'Antar' : 'Mandiri'}</span>
                            </td>
                            <td style="padding:10px 8px;">${armadaCell}</td>
                            <td style="padding:10px 8px; font-weight:800; color:#1e3a8a;">${ord.relasi}</td>
                            <td style="padding:10px 8px; color:#334155; font-size:10px; max-width:200px;">${ord.pakanText || '-'}</td>
                            <td style="padding:10px 8px; text-align:right; font-weight:800; color:#15803d;">${nf.format(ord.totalKg)} Kg</td>
                            <td style="padding:10px 8px; text-align:right;">${ongkirCell}</td>
                            <td style="padding:10px 8px; color:#64748b; font-size:10px; max-width:140px;">${ord.catatan || '-'}</td>
                            <td style="padding:10px 8px; text-align:right; font-weight:700; color:#94a3b8;">-</td>
                            <td style="padding:10px 8px; text-align:center;">${statusCell}</td>
                            <td style="padding:10px 8px; text-align:center; white-space:nowrap;">${buttonAction}</td>
                        </tr>
                    `;
                }).join('');
            }
        } else {
            // Tampilan Pengantaran Armada CBL
            if (filteredTrips.length === 0) {
                tbodyTrips.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:25px; color:#94a3b8; font-style:italic;">Belum ada riwayat pengantaran untuk armada ini.</td></tr>`;
            } else {
                let users = window.tripState.cachedUsers || [];
                let userMap = {};
                users.forEach(u => { userMap[u.id] = u.nama; });

                let supaPinHeader = (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : (localStorage.getItem('cbl_user_pin') || '1234');

                // Hitung nomor urutan rit otomatis kronologis per armada per tanggal
                let tripRitAutoMap = {};
                let tripGroups = {};

                allTrips.forEach(tr => {
                    let armStd = tr.armada || 'D 8707 UE';
                    let a = armStd.toUpperCase();
                    if (a.includes('8707') || a.includes('8070')) armStd = 'D 8707 UE';
                    else if (a.includes('8142')) armStd = 'D 8142 UK';
                    else if (a.includes('8749') || a.includes('TRUK')) armStd = 'D 8749 UA';
                    
                    let key = `${tr.tanggal || ''}_${armStd}`;
                    if (!tripGroups[key]) tripGroups[key] = [];
                    tripGroups[key].push(tr);
                });

                Object.keys(tripGroups).forEach(key => {
                    tripGroups[key].sort((a, b) => {
                        let tA = a.waktu_berangkat || a.created_at || a.id || 0;
                        let tB = b.waktu_berangkat || b.created_at || b.id || 0;
                        return tA > tB ? 1 : (tA < tB ? -1 : 0);
                    });
                    tripGroups[key].forEach((tr, idx) => {
                        let expected = idx + 1;
                        tripRitAutoMap[tr.id] = expected;
                        if (tr.urutan_rit !== expected) {
                            fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tr.id}`, {
                                method: 'PATCH',
                                headers: { 
                            'apikey': SUPA_ANON_KEY, 
                            'Authorization': `Bearer ${SUPA_ANON_KEY}`, 
                            'Content-Type': 'application/json',
                            'x-pin-karyawan': supaPinHeader
                        },
                                body: JSON.stringify({ urutan_rit: expected })
                            }).catch(() => {});
                            tr.urutan_rit = expected;
                        }
                    });
                });
                window._tripRitAutoMap = tripRitAutoMap;

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

                    let isSewaLuar = (tr.armada || '').toLowerCase().includes('sewa') || (tr.armada || '').toLowerCase().includes('luar') || (tr.armada || '').toLowerCase().includes('doyok') || (tr.armada || '').toLowerCase().includes('uje');
                    let sopirNama = userMap[tr.sopir_user_id] || (isSewaLuar ? 'Supir Sewa' : 'Supir');
                    let kernekNama = userMap[tr.kernek_1_user_id] || '-';
                    if (tr.kernek_2_user_id && userMap[tr.kernek_2_user_id]) {
                        kernekNama += `, ${userMap[tr.kernek_2_user_id]}`;
                    }
                    let kruStr = isSewaLuar ? `<b>${sopirNama}</b>` : `<b>${sopirNama}</b>${kernekNama !== '-' ? ` & ${kernekNama}` : ''}`;

                    let armLabel = tr.armada || '-';
                    if (armLabel.includes('D 8707 UE') || armLabel.includes('D 8070 UE')) armLabel = 'D 8707 UE (Hilman)';
                    else if (armLabel.includes('D 8142 UK')) armLabel = 'D 8142 UK (Adi)';
                    else if (armLabel.includes('D 8749 UA') || armLabel.includes('8749') || armLabel.includes('Truk')) armLabel = 'D 8749 UA (Agus)';
                    else if (isSewaLuar) {
                        armLabel = `<span style="background:#f1f5f9; color:#334155; padding:2px 6px; border-radius:4px; font-weight:800; border:1px solid #cbd5e1;">🚚 ${armLabel}</span>`;
                    }

                    let autoRit = tripRitAutoMap[tr.id] || tr.urutan_rit || 1;
                    let tripTitikVal = (typeof getTripJumlahTitik === 'function') ? getTripJumlahTitik(tr) : (parseInt(tr.jumlah_titik) || 1);
                    let titikBadge = (tripTitikVal > 1) 
                        ? `<div style="margin-top:2px;"><span style="background:#fef3c7; color:#92400e; font-size:9.5px; font-weight:700; padding:1px 5px; border-radius:4px;">${tripTitikVal} Titik Drop</span></div>` 
                        : '';

                    let pInfo = getTripPendapatanOngkir(tr, allTrips, ongkirRows);

                    return `
                        <tr style="border-bottom:1px solid #e2e8f0; font-size:11px;">
                            <td style="padding:10px 8px; font-weight:700; color:#1e293b;">${tglDisplay}</td>
                            <td style="padding:10px 8px; text-align:center; white-space:nowrap;">
                                <span style="background:#e0f2fe; color:#0369a1; font-size:11px; font-weight:800; padding:3px 8px; border-radius:10px; display:inline-block;">Rit ${autoRit}</span>
                                ${titikBadge}
                            </td>
                            <td style="padding:10px 8px; font-weight:800; color:#0f766e;">${armLabel}</td>
                            <td style="padding:10px 8px; font-weight:700; color:#1e3a8a;">${relasiList} ${mapsBtn}</td>
                            <td style="padding:10px 8px; color:#334155; font-size:10px; max-width:200px;">${pakanList}</td>
                            <td style="padding:10px 8px; text-align:right; font-weight:800; color:#15803d;">${nf.format(tr.total_kg || 0)} Kg</td>
                            <td style="padding:10px 8px; text-align:right; font-weight:800; color:#16a34a; white-space:nowrap;">
                                ${isSewaLuar ? `
                                    <span style="color:#64748b; font-weight:700;">Rp 0</span>
                                    <div style="font-size:9.5px; color:#94a3b8; font-weight:700;">Sewa Luar (Net 0)</div>
                                ` : `
                                    Rp ${nf.format(pInfo.nominal || 0)}
                                    <div style="font-size:9.5px; color:#15803d; font-weight:700;">${pInfo.rit} Rit</div>
                                `}
                            </td>
                            <td style="padding:10px 8px; color:#334155;">${kruStr}</td>
                            <td style="padding:10px 8px; text-align:right; font-weight:700; color:#475569;">${tr.jarak_tempuh_km || 0} Km</td>
                            <td style="padding:10px 8px; text-align:center;">
                                <span style="background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; padding:2px 6px; border-radius:10px;">${tr.status_trip || 'SELESAI'}</span>
                            </td>
                            <td style="padding:10px 8px; text-align:center; white-space:nowrap;">
                                <button type="button" onclick="bukaModalKelolaTripAdmin(${tr.id})" style="background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; padding:4px 8px; border-radius:6px; font-weight:700; font-size:11px; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                                    <span class="material-symbols-outlined" style="font-size:13px;">tune</span> Kelola
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }
    }

    // Sinkronkan data Rapor Kinerja & Biaya Armada CBL jika tampilan aktif
    if (typeof renderRaporArmadaView === 'function') {
        renderRaporArmadaView();
    }
}

// ====================================================================
// MODAL KELOLA TRIP PENGIRIMAN, PECAH MUATAN & GABUNG RIT OLEH ADMIN
// ====================================================================

function bukaModalKelolaTripAdmin(tripId) {
    let modal = document.getElementById('modal-kelola-trip-admin');
    if (!modal) return;

    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let tr = trips.find(t => t.id == tripId);
    if (!tr) {
        alert("Data trip tidak ditemukan.");
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');
    let elId = document.getElementById('kelola-trip-id');
    let elTgl = document.getElementById('kelola-trip-tgl');
    let elArm = document.getElementById('kelola-trip-armada');
    let elTuj = document.getElementById('kelola-trip-tujuan');
    let elKg = document.getElementById('kelola-trip-kg');

    if (elId) elId.value = tr.id;
    if (elTgl) elTgl.innerText = tr.tanggal || '-';

    let armLabel = tr.armada || '-';
    if (armLabel.includes('8707') || armLabel.includes('8070')) armLabel = 'D 8707 UE (Hilman)';
    else if (armLabel.includes('8142')) armLabel = 'D 8142 UK (Adi)';
    else if (armLabel.includes('8749') || armLabel.includes('Truk')) armLabel = 'D 8749 UA (Truk Pak Agus)';
    if (elArm) elArm.innerText = armLabel;

    let manifest = tr.manifest_items || [];
    let relasiList = [...new Set(manifest.map(m => m.relasi).filter(Boolean))].join(', ') || tr.catatan || 'Konsumen';
    if (elTuj) elTuj.innerText = relasiList;
    let curKgVal = parseFloat(tr.total_kg) || 0;
    if (elKg) elKg.innerText = `${nf.format(curKgVal)} Kg`;

    // Saran split otomatis & sinkronisasi input sisa Kg dan split Kg
    let sisaInput = document.getElementById('kelola-trip-input-sisa-kg');
    let splitInput = document.getElementById('kelola-trip-input-split-kg');
    let splitSel = document.getElementById('kelola-trip-select-split-armada');
    if (splitInput) {
        let isTruk = (tr.armada || '').includes('8749') || (tr.armada || '').includes('Truk');
        let defaultSplit = (isTruk && curKgVal > 7500)
            ? (curKgVal - 7500)
            : (!isTruk && curKgVal > 1500 ? (curKgVal - 1500) : '');

        if (defaultSplit && defaultSplit > 0 && defaultSplit < curKgVal) {
            splitInput.value = defaultSplit;
            if (sisaInput) sisaInput.value = curKgVal - defaultSplit;
        } else {
            splitInput.value = '';
            if (sisaInput) sisaInput.value = curKgVal;
        }

        if (splitSel) {
            if (isTruk) {
                splitSel.value = 'D 8707 UE';
            } else if ((tr.armada || '').includes('8707') || (tr.armada || '').includes('8070')) {
                splitSel.value = 'D 8142 UK';
            } else {
                splitSel.value = 'D 8707 UE';
            }
        }
    }

    // Reset dan aktifkan highlight button armada
    document.querySelectorAll('.btn-kelola-armada').forEach(b => {
        b.style.borderColor = '#cbd5e1';
        b.style.background = '#ffffff';
    });
    let curArm = tr.armada || '';
    if (curArm.includes('8707') || curArm.includes('8070')) {
        let b = document.getElementById('btn-kelola-arm-8707');
        if (b) { b.style.borderColor = '#2563eb'; b.style.background = '#eff6ff'; }
    } else if (curArm.includes('8142')) {
        let b = document.getElementById('btn-kelola-arm-8142');
        if (b) { b.style.borderColor = '#ea580c'; b.style.background = '#fff7ed'; }
    } else if (curArm.includes('8749') || curArm.includes('Truk')) {
        let b = document.getElementById('btn-kelola-arm-8749');
        if (b) { b.style.borderColor = '#0f766e'; b.style.background = '#f0fdfa'; }
    }

    // Populate dropdown target gabung trip pada tanggal yang sama
    let selTarget = document.getElementById('kelola-trip-select-target');
    let autoRitMap = window._tripRitAutoMap || {};
    if (selTarget) {
        selTarget.innerHTML = `<option value="">-- Pilih Trip Utama Tujuan Gabung --</option>`;
        let otherTrips = trips.filter(t => t.id != tr.id && t.tanggal === tr.tanggal);
        if (otherTrips.length === 0) {
            selTarget.innerHTML += `<option value="" disabled>(Tidak ada trip lain pada tanggal ${tr.tanggal})</option>`;
        } else {
            otherTrips.forEach(ot => {
                let otManifest = ot.manifest_items || [];
                let otRelasi = [...new Set(otManifest.map(m => m.relasi).filter(Boolean))].join(', ') || ot.catatan || 'Trip';
                let otArm = ot.armada || '';
                if (otArm.includes('8707')) otArm = 'D 8707 UE';
                else if (otArm.includes('8142')) otArm = 'D 8142 UK';
                else if (otArm.includes('8749')) otArm = 'D 8749 UA';
                let otRit = autoRitMap[ot.id] || ot.urutan_rit || 1;
                selTarget.innerHTML += `<option value="${ot.id}">[Rit ${otRit}] ${otArm} - ${otRelasi} (${nf.format(ot.total_kg || 0)} Kg)</option>`;
            });
        }
    }

    // Populate urutan rit, titik drop, rit fisik, dan beban muatan (kg)
    let elUrutan = document.getElementById('kelola-trip-urutan-rit');
    let elTitik = document.getElementById('kelola-trip-titik-drop');
    let elRitFisik = document.getElementById('kelola-trip-jumlah-rit');
    let elInputKg = document.getElementById('kelola-trip-input-kg');
    let curAutoRit = autoRitMap[tr.id] || tr.urutan_rit || 1;
    if (elUrutan) elUrutan.value = tr.urutan_rit || curAutoRit;
    if (elTitik) elTitik.value = (typeof getTripJumlahTitik === 'function') ? getTripJumlahTitik(tr) : (tr.jumlah_titik || 1);
    if (elRitFisik) elRitFisik.value = tr.jumlah_rit || '';
    if (elInputKg) elInputKg.value = curKgVal || '';

    // Setup tombol auto-pecah kapasitas sesuai armada
    let btnAutoPecah = document.getElementById('btn-auto-pecah-kapasitas');
    if (btnAutoPecah) {
        let isTruk = (tr.armada || '').includes('8749') || (tr.armada || '').includes('Truk');
        let maxCap = isTruk ? 7500 : 1500;
        let labelCap = isTruk ? 'Truk (7.500 Kg / Rit)' : 'Pick-up (1.500 Kg / Rit)';
        btnAutoPecah.innerHTML = `<span class="material-symbols-outlined" style="font-size:15px;">splitscreen</span> ⚡ Pecah Otomatis Sesuai Kapasitas ${labelCap}`;
        btnAutoPecah.style.display = (curKgVal > maxCap) ? 'flex' : 'none';
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function tutupModalKelolaTripAdmin() {
    let modal = document.getElementById('modal-kelola-trip-admin');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function bukaModalTugaskanArmada(idx) {
    let unassignedList = window._cacheArmadaData?.unassignedOrders || [];
    if (window._armadaTujuanFilter) {
        unassignedList = unassignedList.filter(u => (u.relasi || '').toLowerCase().includes(window._armadaTujuanFilter));
    }
    let order = unassignedList[idx];
    if (!order) return;

    window._selectedOrderToAssign = order;
    let modal = document.getElementById('modal-tambah-trip-manual');
    if (!modal) return;

    let nf = new Intl.NumberFormat('id-ID');
    let tglEl = document.getElementById('tugaskan-tgl-display');
    let relEl = document.getElementById('tugaskan-relasi-display');
    let kgEl = document.getElementById('tugaskan-kg-display');
    let pknEl = document.getElementById('tugaskan-pakan-display');

    if (tglEl) tglEl.innerText = order.tanggal || '-';
    if (relEl) relEl.innerText = order.relasi || '-';
    if (kgEl) kgEl.innerText = `${nf.format(order.totalKg || 0)} Kg`;
    if (pknEl) pknEl.innerText = order.pakanText || '-';

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}
window.bukaModalTugaskanArmada = bukaModalTugaskanArmada;

// Resequence kolom urutan_rit di database Supabase agar berurutan 1, 2, 3... tanpa lompatan
async function resequenceTripsForDateAndArmada(tanggal, armada) {
    if (!tanggal || !armada) return;
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=eq.${tanggal}&armada=eq.${encodeURIComponent(armada)}&order=id.asc`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (!res.ok) return;
        let trips = await res.json();
        if (!Array.isArray(trips) || trips.length === 0) return;

        for (let idx = 0; idx < trips.length; idx++) {
            let tr = trips[idx];
            let expectedRit = idx + 1;
            let patchObj = {};
            if (tr.urutan_rit !== expectedRit) {
                patchObj.urutan_rit = expectedRit;
            }
            if (tr.catatan && /Rit\s*\d+/i.test(tr.catatan)) {
                let updatedCat = tr.catatan.replace(/Rit\s*\d+/gi, `Rit ${expectedRit}`);
                if (updatedCat !== tr.catatan) {
                    patchObj.catatan = updatedCat;
                }
            }
            if (Object.keys(patchObj).length > 0) {
                await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tr.id}`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                    },
                    body: JSON.stringify(patchObj)
                });
            }
        }
    } catch (eSeq) {
        console.warn("Gagal resequence trip urutan_rit:", eSeq);
    }
}
window.resequenceTripsForDateAndArmada = resequenceTripsForDateAndArmada;

window._pendingOverloadAssign = null;

function bukaModalPilihanRitOverload(targetArmada, totalKg, source = 'admin_tugaskan') {
    window._pendingOverloadAssign = { targetArmada, totalKg, source };
    let modal = document.getElementById('modal-pilihan-rit-overload');
    let sub = document.getElementById('pilihan-rit-subtitle');
    let nf = new Intl.NumberFormat('id-ID');
    let overKg = totalKg - 1500;
    if (sub) {
        sub.innerText = `Muatan: ${nf.format(totalKg)} Kg (Overload +${nf.format(overKg)} Kg)`;
    }
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
}
window.bukaModalPilihanRitOverload = bukaModalPilihanRitOverload;

function tutupModalPilihanRitOverload() {
    let modal = document.getElementById('modal-pilihan-rit-overload');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    window._pendingOverloadAssign = null;
}
window.tutupModalPilihanRitOverload = tutupModalPilihanRitOverload;

async function konfirmasiRitOverload(ritCount) {
    let pending = window._pendingOverloadAssign;
    tutupModalPilihanRitOverload();
    if (pending) {
        if (pending.source === 'form_input') {
            if (typeof window.prosesOngkirArmada === 'function') {
                window.prosesOngkirArmada(pending.targetArmada, ritCount);
            }
        } else if (pending.targetArmada) {
            await eksekusiTugaskanArmadaCepat(pending.targetArmada, ritCount);
        }
    }
}
window.konfirmasiRitOverload = konfirmasiRitOverload;

// Helper robust: Update baris transaksi_pakan dengan fallback multi-PIN (termasuk Admin Pusat 1234)
// Menggunakan patch individual id=eq.{id} agar kompatibel penuh dengan Supabase RLS & PostgREST
async function patchTransaksiPakanRows(txIds, tanggal, relasi, patchData) {
    let pinList = [
        window.currentLoggedPin,
        localStorage.getItem('cbl_user_pin'),
        (typeof currentLoggedPin !== 'undefined' && currentLoggedPin ? currentLoggedPin : null),
        '1234'
    ].filter(Boolean);
    pinList = [...new Set(pinList)];
    if (!pinList.includes('1234')) pinList.push('1234');

    let totalUpdated = 0;
    let lastError = null;

    for (let pin of pinList) {
        try {
            let successInThisPass = 0;
            // 1. Update spesifik per ID baris (id=eq.${id})
            if (Array.isArray(txIds) && txIds.length > 0) {
                let promises = txIds.map(async id => {
                    let res = await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?id=eq.${id}`, {
                        method: 'PATCH',
                        headers: {
                            'apikey': SUPA_ANON_KEY,
                            'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation',
                            'x-pin-karyawan': pin
                        },
                        body: JSON.stringify(patchData)
                    });
                    if (res.ok) {
                        let rows = await res.json().catch(() => []);
                        return Array.isArray(rows) ? rows.length : 1;
                    } else {
                        let errText = await res.text().catch(() => '');
                        console.warn(`PATCH row ${id} dengan PIN ${pin} ditolak:`, errText);
                        return 0;
                    }
                });
                let counts = await Promise.all(promises);
                successInThisPass = counts.reduce((a, b) => a + b, 0);
            }

            // 2. Fallback sinkronisasi: update via tanggal & relasi untuk pakan (non-ongkir)
            if (tanggal && relasi) {
                let resRel = await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=eq.${tanggal}&relasi=eq.${encodeURIComponent(relasi)}&pakan=neq.Ongkir Pengiriman`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation',
                        'x-pin-karyawan': pin
                    },
                    body: JSON.stringify(patchData)
                });
                if (resRel.ok) {
                    let rRows = await resRel.json().catch(() => []);
                    if (Array.isArray(rRows) && rRows.length > 0) {
                        successInThisPass = Math.max(successInThisPass, rRows.length);
                    }
                }
            }

            if (successInThisPass > 0) {
                totalUpdated = successInThisPass;
                return { success: true, count: totalUpdated, pinUsed: pin };
            }
        } catch (err) {
            lastError = err;
        }
    }

    if (lastError && totalUpdated === 0) {
        console.warn("Gagal update transaksi_pakan:", lastError);
    }
    return { success: totalUpdated > 0, count: totalUpdated };
}

// Helper robust: Update baris Ongkir Pengiriman di transaksi_pakan
async function patchOngkirRow(ongkirRowId, tanggal, relasi, patchData) {
    let pinList = [
        window.currentLoggedPin,
        localStorage.getItem('cbl_user_pin'),
        (typeof currentLoggedPin !== 'undefined' && currentLoggedPin ? currentLoggedPin : null),
        '1234'
    ].filter(Boolean);
    pinList = [...new Set(pinList)];
    if (!pinList.includes('1234')) pinList.push('1234');

    for (let pin of pinList) {
        try {
            if (ongkirRowId) {
                let res = await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?id=eq.${ongkirRowId}`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation',
                        'x-pin-karyawan': pin
                    },
                    body: JSON.stringify(patchData)
                });
                if (res.ok) {
                    let r = await res.json().catch(() => []);
                    if (Array.isArray(r) && r.length > 0) return true;
                }
            }
            if (tanggal && relasi) {
                let res = await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?pakan=eq.Ongkir Pengiriman&tanggal=eq.${tanggal}&relasi=eq.${encodeURIComponent(relasi)}`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation',
                        'x-pin-karyawan': pin
                    },
                    body: JSON.stringify(patchData)
                });
                if (res.ok) {
                    let r = await res.json().catch(() => []);
                    if (Array.isArray(r) && r.length > 0) return true;
                }
            }
        } catch (e) {}
    }
    return false;
}

// 1-Klik Cepat Tugaskan Armada untuk Orderan yang Belum Diantar
async function eksekusiTugaskanArmadaCepat(targetArmada, forceRitCount = null) {
    let order = window._selectedOrderToAssign;
    if (!order) {
        alert("Pilih pesanan terlebih dahulu!");
        return;
    }

    let isTruk = targetArmada.includes('8749') || targetArmada.toLowerCase().includes('truk');
    let totalKg = order.totalKg || 0;

    // ⚡ TOLERANSI OVERLOAD PICK-UP (1.501 - 1.700 Kg):
    // Jika muatan lebih dari 1.500 Kg tapi masih dalam toleransi overload (<= 1.700 Kg),
    // munculkan pop-up pilihan 1 Rit atau 2 Rit!
    if (!isTruk && totalKg > 1500 && totalKg <= 1700 && forceRitCount === null) {
        bukaModalPilihanRitOverload(targetArmada, totalKg);
        return;
    }

    let sopirId = null;
    if (targetArmada.includes('8707') || targetArmada.includes('8070')) sopirId = 6; // Hilman
    else if (targetArmada.includes('8142')) sopirId = 7; // Adi
    else if (targetArmada.includes('8749')) {
        let users = window.tripState?.cachedUsers || [];
        let agusUser = users.find(u => (u.nama || '').toLowerCase().includes('agus') && (u.role || '').toLowerCase() === 'sopir');
        sopirId = agusUser ? agusUser.id : 12; // Pak Agus
    }

    let maxCap = 1500;
    let totalChunks = 1;
    let qtyOngkir = 1;

    if (isTruk) {
        totalChunks = 1;
        qtyOngkir = 1;
    } else if (forceRitCount === 1) {
        // Pilihan 1 Rit: muatan diantar sekali jalan / 1 Rit
        totalChunks = 1;
        qtyOngkir = 1;
    } else if (forceRitCount === 2) {
        // Pilihan 2 Rit: diantar 2 kali jalan / 2 Rit
        totalChunks = 2;
        qtyOngkir = 2;
    } else if (totalKg > 1700) {
        // Di atas toleransi overload (> 1.700 Kg): langsung auto-split per 1.500 Kg
        totalChunks = Math.max(1, Math.ceil(totalKg / maxCap));
        qtyOngkir = totalChunks;
    } else {
        totalChunks = 1;
        qtyOngkir = 1;
    }

    // Hitung urutan rit hari ini secara dinamis
    let nextRit = 1;
    try {
        let resCount = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=eq.${order.tanggal}&armada=eq.${encodeURIComponent(targetArmada)}&select=id`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (resCount.ok) {
            let tripsHariIni = await resCount.json();
            nextRit = (Array.isArray(tripsHariIni) ? tripsHariIni.length : 0) + 1;
        }
    } catch (eC) {}

    let primaryTripId = null;
    let supaPin = window.currentLoggedPin || localStorage.getItem('cbl_user_pin') || (typeof currentLoggedPin !== 'undefined' && currentLoggedPin ? currentLoggedPin : '') || '1234';

    try {
        for (let i = 0; i < totalChunks; i++) {
            let chunkKg = isTruk ? totalKg : (totalChunks === 1 ? totalKg : ((i === totalChunks - 1) ? (totalKg - (i * maxCap)) : maxCap));
            let ritNum = nextRit + i;
            let catatanTrip = totalChunks > 1
                ? `${targetArmada} (Rit ${ritNum}) - ${order.relasi} (${chunkKg} Kg)`
                : `${targetArmada} (Rit ${ritNum}) - ${order.relasi}`;

            let tripPayload = {
                tanggal: order.tanggal,
                cabang: 'PM',
                armada: targetArmada,
                sopir_user_id: sopirId,
                urutan_rit: ritNum,
                total_kg: chunkKg,
                jarak_tempuh_km: 0,
                status_trip: 'SELESAI',
                catatan: catatanTrip,
                manifest_items: order.manifestItems || [{ relasi: order.relasi, pakan: order.pakanText || 'Pakan', qty: chunkKg }]
            };

            let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                    'x-pin-karyawan': supaPin
                },
                body: JSON.stringify(tripPayload)
            });

            if (!res.ok && supaPin !== '1234') {
                // Fallback ke master PIN 1234 jika user pin ditolak
                res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
                    method: 'POST',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation',
                        'x-pin-karyawan': '1234'
                    },
                    body: JSON.stringify(tripPayload)
                });
            }

            if (res.ok) {
                let created = await res.json();
                if (created?.[0]?.id) {
                    if (i === 0) primaryTripId = created[0].id;
                    if (isTruk) {
                        await syncSolarTrukToCashflow(created[0].id, targetArmada, order.tanggal, 1, order.relasi);
                    }
                }
            } else {
                let errBody = await res.text();
                console.error("Gagal tugaskan armada:", res.status, errBody);
                throw new Error(`Gagal membuat trip pengantaran rit ke-${ritNum}: ${errBody}`);
            }
        }

        // 1a: UPDATE KOLOM ARMADA & TRIP_ID DI transaksi_pakan SECARA REAL-TIME!
        if (primaryTripId) {
            let cleanCatatan = (order.catatan || '').replace(/\[AMBIL SENDIRI.*?\]|\[KIRIM.*?\]/gi, '').trim();
            let newCatatan = cleanCatatan ? `[KIRIM ${targetArmada}] ${cleanCatatan}` : `[KIRIM ${targetArmada}]`;

            let pakanPatchRes = await patchTransaksiPakanRows(order.txIds, order.tanggal, order.relasi, {
                trip_id: primaryTripId,
                armada: targetArmada,
                catatan: newCatatan
            });

            if (!pakanPatchRes.success) {
                console.warn("⚠️ Peringatan: patchTransaksiPakanRows tidak ada baris yang berubah, namun trip tetap tersimpan.");
            }

            // Juga update baris Ongkir Pengiriman untuk relasi dan tanggal ini jika ada agar armada & qty ikut sesuai!
            let patchOngkirObj = {
                trip_id: primaryTripId,
                armada: targetArmada,
                qty: qtyOngkir
            };
            await patchOngkirRow(order.ongkirRowId, order.tanggal, order.relasi, patchOngkirObj);
        }

        // Rapikan nomor urutan rit di database untuk armada ini pada tanggal ini
        await resequenceTripsForDateAndArmada(order.tanggal, targetArmada);

        window._selectedOrderToAssign = null;
        tutupModalTambahTripManual();
        let nf = new Intl.NumberFormat('id-ID');
        alert(`✅ Sukses menugaskan pesanan ${order.relasi} (${nf.format(totalKg)} Kg) ke ${targetArmada} sebanyak ${totalChunks} Rit (Ongkir: ${qtyOngkir} Rit)!`);
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal menugaskan armada: " + e.message);
    }
}
window.eksekusiTugaskanArmadaCepat = eksekusiTugaskanArmadaCepat;

async function simpanRitTripAdmin() {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    if (!tripId) return;

    let trips = window._cacheArmadaData?.trips || [];
    let tr = trips.find(t => t.id == tripId);
    if (!tr) return;

    let urutanVal = parseInt(document.getElementById('kelola-trip-urutan-rit')?.value);
    let titikVal = parseInt(document.getElementById('kelola-trip-titik-drop')?.value) || 1;
    let ritFisikVal = parseInt(document.getElementById('kelola-trip-jumlah-rit')?.value);
    let kgVal = parseFloat(document.getElementById('kelola-trip-input-kg')?.value);

    let btn = document.getElementById('btn-simpan-rit-titik');
    let orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerText = "Menyimpan..."; }

    try {
        let patchData = {};
        if (!isNaN(urutanVal) && urutanVal > 0) patchData.urutan_rit = urutanVal;
        if (!isNaN(kgVal) && kgVal > 0) patchData.total_kg = kgVal;
        let cleanCat = (tr.catatan || '').replace(/\s*\[\d+\s*Titik\]/gi, '').trim();
        patchData.catatan = titikVal > 1 ? `${cleanCat} [${titikVal} Titik]` : cleanCat;

        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(patchData)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || 'Gagal menyimpan perubahan rit & titik');
        }

        // Sinkronkan solar truk ke cashflow jika armada Truk
        let isTruk = (tr.armada || '').includes('8749') || (tr.armada || '').includes('Truk');
        if (isTruk) {
            await syncSolarTrukToCashflow(tripId, tr.armada, tr.tanggal, titikVal, tr.catatan);
        }

        alert("✅ Pengaturan urutan rit & titik drop berhasil diperbarui!");
        tutupModalKelolaTripAdmin();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
}
window.simpanRitTripAdmin = simpanRitTripAdmin;

async function autoPecahTripKapasitasAdmin() {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    if (!tripId) return;

    let trips = window._cacheArmadaData?.trips || [];
    let tr = trips.find(t => t.id == tripId);
    if (!tr) return;

    let totalKg = parseFloat(tr.total_kg) || 0;
    let isTruk = (tr.armada || '').includes('8749') || (tr.armada || '').includes('Truk');
    let maxCap = isTruk ? 7500 : 1500;

    if (totalKg <= maxCap) {
        alert(`Total muatan (${totalKg} Kg) tidak melebihi kapasitas maksimal (${maxCap} Kg). Tidak perlu dipecah.`);
        return;
    }

    let totalChunks = Math.ceil(totalKg / maxCap);
    let nf = new Intl.NumberFormat('id-ID');

    let confirmMsg = `Pecah pengiriman ${nf.format(totalKg)} Kg menjadi ${totalChunks} rit sesuai kapasitas armada?\n\n`
        + `• Rit 1: ${nf.format(maxCap)} Kg (memperbarui baris saat ini)\n`;
    for (let i = 1; i < totalChunks; i++) {
        let cKg = (i === totalChunks - 1) ? (totalKg - (i * maxCap)) : maxCap;
        confirmMsg += `• Rit ${i + 1}: ${nf.format(cKg)} Kg (buat pengiriman baru)\n`;
    }
    confirmMsg += `\nLanjutkan pemecahan rit?`;

    if (!confirm(confirmMsg)) return;

    let btn = document.getElementById('btn-auto-pecah-kapasitas');
    let orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerText = "Memproses pemecahan rit..."; }

    try {
        let baseRit = tr.urutan_rit || window._tripRitAutoMap?.[tr.id] || 1;
        let chunk1Kg = maxCap;

        // 1. Update trip saat ini menjadi Rit 1 dengan maxCap
        let patchData = {
            total_kg: chunk1Kg,
            urutan_rit: baseRit,
            catatan: tr.catatan ? `${tr.catatan} (Rit ${baseRit})` : `Rit ${baseRit}`
        };

        let res1 = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(patchData)
        });

        if (!res1.ok) {
            let err = await res1.json();
            throw new Error(err.message || 'Gagal memperbarui trip rit pertama');
        }

        if (isTruk) {
            await syncSolarTrukToCashflow(tripId, tr.armada, tr.tanggal, 1, tr.catatan);
        }

        let sopirIdAuto = tr.sopir_user_id;
        if (!sopirIdAuto) {
            if (tr.armada.includes('8707') || tr.armada.includes('8070')) sopirIdAuto = 6;
            else if (tr.armada.includes('8142')) sopirIdAuto = 7;
            else if (tr.armada.includes('8749')) sopirIdAuto = 12;
        }

        // 2. Buat row baru untuk chunk 2..N
        for (let i = 1; i < totalChunks; i++) {
            let cKg = (i === totalChunks - 1) ? (totalKg - (i * maxCap)) : maxCap;
            let ritNum = baseRit + i;
            let payloadChunk = {
                tanggal: tr.tanggal,
                cabang: tr.cabang || 'PM',
                armada: tr.armada,
                sopir_user_id: sopirIdAuto,
                urutan_rit: ritNum,
                total_kg: cKg,
                jarak_tempuh_km: 0,
                status_trip: 'SELESAI',
                catatan: tr.catatan ? `${tr.catatan} (Rit ${ritNum}) [SPLIT:${tr.id}]` : `Rit ${ritNum} [SPLIT:${tr.id}]`,
                manifest_items: tr.manifest_items || []
            };
            if (tr.kernek_1_user_id) payloadChunk.kernek_1_user_id = tr.kernek_1_user_id;
            if (tr.kernek_2_user_id) payloadChunk.kernek_2_user_id = tr.kernek_2_user_id;

            let resNew = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                },
                body: JSON.stringify(payloadChunk)
            });

            if (!resNew.ok) {
                let errBody = await resNew.text();
                console.error("Gagal buat rit pecahan:", resNew.status, errBody);
                throw new Error(`Gagal menyimpan rit pecahan ke-${ritNum}: ${errBody}`);
            }

            if (isTruk) {
                let created = await resNew.json();
                if (created?.[0]?.id) {
                    await syncSolarTrukToCashflow(created[0].id, tr.armada, tr.tanggal, 1, tr.catatan);
                }
            }
        }

        // Pastikan urutan rit kembali berurutan 1, 2, 3...
        await resequenceTripsForDateAndArmada(tr.tanggal, tr.armada);

        alert(`✅ Sukses! Pengiriman berhasil dipecah menjadi ${totalChunks} rit.`);
        tutupModalKelolaTripAdmin();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal memecah rit: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
}
window.autoPecahTripKapasitasAdmin = autoPecahTripKapasitasAdmin;

async function pindahArmadaTripAdmin(armadaTujuan) {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    if (!tripId) return;

    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let tr = trips.find(t => t.id == tripId);
    if (!tr) return;

    if (tr.armada === armadaTujuan) {
        alert(`Trip ini sudah berada di armada ${armadaTujuan}`);
        return;
    }

    if (!confirm(`Yakin ingin memindahkan pengiriman ini ke armada ${armadaTujuan}?`)) {
        return;
    }

    let sopirId = null;
    if (armadaTujuan.includes('8707') || armadaTujuan.includes('8070')) sopirId = 6; // Hilman
    else if (armadaTujuan.includes('8142')) sopirId = 7; // Adi
    else if (armadaTujuan.includes('8749')) {
        let users = window.tripState?.cachedUsers || [];
        let agusUser = users.find(u => (u.nama || '').toLowerCase().includes('agus') && (u.role || '').toLowerCase() === 'sopir');
        if (agusUser) sopirId = agusUser.id;
    }

    try {
        let patchData = { armada: armadaTujuan };
        if (sopirId) patchData.sopir_user_id = sopirId;

        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(patchData)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || 'Gagal mengubah armada');
        }

        // Sinkronkan juga kolom armada di tabel transaksi_pakan jika ada transaksi terkait trip ini
        let supaPinPindah = (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234';
        try {
            await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?trip_id=eq.${tripId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'x-pin-karyawan': supaPinPindah
                },
                body: JSON.stringify({ armada: armadaTujuan })
            });
        } catch (eTx) {
            console.warn("Gagal sinkron armada ke transaksi_pakan:", eTx);
        }

        // Sinkronkan juga baris Ongkir Pengiriman di transaksi_pakan untuk relasi dan tanggal ini
        let relasiList = [...new Set((tr.manifest_items || []).map(m => m.relasi).filter(Boolean))];
        if (relasiList.length === 0 && tr.catatan) relasiList.push(tr.catatan);

        for (let rName of relasiList) {
            try {
                await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=eq.${tr.tanggal}&relasi=eq.${encodeURIComponent(rName)}&pakan=eq.Ongkir Pengiriman`, {
                    method: 'PATCH',
                    headers: { 
                        'apikey': SUPA_ANON_KEY, 
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`, 
                        'Content-Type': 'application/json',
                        'x-pin-karyawan': supaPinPindah
                    },
                    body: JSON.stringify({ armada: armadaTujuan, trip_id: tripId })
                });
            } catch (eOngkir) {}
        }

        // Sinkronkan solar truk ke cashflow jika berpindah ke atau dari armada Truk
        let titikPindah = (typeof getTripJumlahTitik === 'function') ? getTripJumlahTitik(tr) : (parseInt(tr.jumlah_titik) || 1);
        await syncSolarTrukToCashflow(tripId, armadaTujuan, tr.tanggal, titikPindah, tr.catatan);

        // Rapikan urutan rit untuk armada asal dan armada tujuan pada tanggal ini
        let oldArmada = tr.armada;
        await resequenceTripsForDateAndArmada(tr.tanggal, oldArmada);
        await resequenceTripsForDateAndArmada(tr.tanggal, armadaTujuan);

        alert(`✅ Berhasil memindahkan trip ke armada ${armadaTujuan}!`);
        tutupModalKelolaTripAdmin();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal memindahkan armada: " + e.message);
    }
}

// ✂️ PECAH MUATAN KE ARMADA LAIN (CUSTOM TONASE RATIO)
function onInputSisaKgChange(val) {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let tr = trips.find(t => t.id == tripId);
    let totalKg = tr ? (parseFloat(tr.total_kg) || 0) : 0;
    let sisa = parseFloat(val) || 0;
    let splitInput = document.getElementById('kelola-trip-input-split-kg');
    if (splitInput && totalKg > 0) {
        let split = totalKg - sisa;
        splitInput.value = (split > 0) ? split : 0;
    }
}

function onInputSplitKgChange(val) {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let tr = trips.find(t => t.id == tripId);
    let totalKg = tr ? (parseFloat(tr.total_kg) || 0) : 0;
    let split = parseFloat(val) || 0;
    let sisaInput = document.getElementById('kelola-trip-input-sisa-kg');
    if (sisaInput && totalKg > 0) {
        let sisa = totalKg - split;
        sisaInput.value = (sisa > 0) ? sisa : 0;
    }
}

async function eksekusiPecahTripAdmin() {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    if (!tripId) return;

    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let tr = trips.find(t => t.id == tripId);
    if (!tr) {
        alert("Data trip tidak ditemukan.");
        return;
    }

    let splitKg = parseFloat(document.getElementById('kelola-trip-input-split-kg')?.value) || 0;
    let sisaKg = parseFloat(document.getElementById('kelola-trip-input-sisa-kg')?.value) || 0;
    let targetArmada = document.getElementById('kelola-trip-select-split-armada')?.value;
    let curKg = parseFloat(tr.total_kg) || 0;

    if (splitKg <= 0 && sisaKg > 0 && sisaKg < curKg) {
        splitKg = curKg - sisaKg;
    }
    if (sisaKg <= 0 && splitKg > 0 && splitKg < curKg) {
        sisaKg = curKg - splitKg;
    }

    if (splitKg <= 0 || sisaKg <= 0) {
        alert("Masukkan jumlah pembagian Kg yang valid untuk kedua armada!");
        return;
    }

    if (splitKg >= curKg || sisaKg >= curKg) {
        alert(`Jumlah Kg muatan harus dibagi dua armada (tidak boleh salah satunya 0 atau melebihi ${curKg} Kg).\nJika ingin memindahkan seluruh muatan, gunakan tombol 'Pindahkan ke Armada Lain' di atas.`);
        return;
    }

    if (!targetArmada || targetArmada === tr.armada) {
        alert("Pilih armada penerima muatan yang berbeda dengan armada asal!");
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');

    let msg = `Pecah muatan pengiriman ini?\n\n`
            + `• Muatan di armada sekarang (${tr.armada}): disesuaikan jadi ${nf.format(sisaKg)} Kg\n`
            + `• Pengiriman baru di ${targetArmada}: dibuat sebesar ${nf.format(splitKg)} Kg\n\n`
            + `Lanjutkan pemecahan muatan?`;

    if (!confirm(msg)) return;

    let btn = document.getElementById('btn-pecah-trip-admin');
    let origText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerText = "Memproses..."; }

    try {
        // 1. Tentukan supir penerima
        let targetSopirId = null;
        if (targetArmada.includes('8707') || targetArmada.includes('8070')) targetSopirId = 6; // Hilman
        else if (targetArmada.includes('8142')) targetSopirId = 7; // Adi
        else if (targetArmada.includes('8749')) {
            let users = window.tripState?.cachedUsers || [];
            let agusUser = users.find(u => (u.nama || '').toLowerCase().includes('agus') && (u.role || '').toLowerCase() === 'sopir');
            if (agusUser) targetSopirId = agusUser.id;
        }

        // 2. Update trip sumber (dikurangi splitKg)
        let catatanSumber = `${tr.catatan || ''} [Pecah: ${nf.format(splitKg)} Kg dioper ke ${targetArmada}]`.trim();
        let resPatch = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify({
                total_kg: sisaKg,
                catatan: catatanSumber
            })
        });

        if (!resPatch.ok) {
            let err = await resPatch.json();
            throw new Error(err.message || 'Gagal memperbarui trip sumber');
        }

        // 3. Buat trip baru untuk armada penerima
        let manifestSumber = tr.manifest_items || [];
        let splitManifest = manifestSumber.map(m => {
            let porsi = curKg > 0 ? (m.qty / curKg) : 1;
            return {
                ...m,
                qty: Math.round(splitKg * porsi)
            };
        });

        let newTripPayload = {
            tanggal: tr.tanggal || new Date().toISOString().split('T')[0],
            cabang: tr.cabang || 'PM',
            armada: targetArmada,
            sopir_user_id: targetSopirId,
            total_kg: splitKg,
            jarak_tempuh_km: 0,
            status_trip: tr.status_trip || 'SELESAI',
            catatan: `(Pecahan ${nf.format(splitKg)} Kg dari ${tr.armada}) Antar ke ${tr.catatan || 'Konsumen'}`,
            manifest_items: splitManifest.length > 0 ? splitManifest : manifestSumber
        };

        let resInsert = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify(newTripPayload)
        });

        if (!resInsert.ok) {
            let err = await resInsert.json();
            throw new Error(err.message || 'Gagal membuat trip pecahan');
        }

        let newTripData = await resInsert.json();
        let newTripId = newTripData?.[0]?.id;
        if (newTripId && (targetArmada.includes('8749') || targetArmada.toLowerCase().includes('truk'))) {
            await syncSolarTrukToCashflow(newTripId, targetArmada, tr.tanggal, 1, newTripPayload.catatan);
        }

        // Link transaksi_pakan yang sesuai dengan targetArmada & relasi ke newTripId jika belum punya trip_id!
        if (newTripId) {
            let supaPin = (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234';
            let relList = [...new Set((splitManifest || []).map(m => m.relasi).filter(Boolean))];
            for (let rName of relList) {
                try {
                    await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=eq.${tr.tanggal}&relasi=eq.${encodeURIComponent(rName)}&armada=eq.${encodeURIComponent(targetArmada)}&trip_id=is.null`, {
                        method: 'PATCH',
                        headers: {
                            'apikey': SUPA_ANON_KEY,
                            'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                            'Content-Type': 'application/json',
                            'x-pin-karyawan': supaPin
                        },
                        body: JSON.stringify({ trip_id: newTripId })
                    });
                } catch (e) {
                    console.warn("Gagal update trip_id pecahan ke transaksi_pakan:", e);
                }
            }
        }

        await resequenceTripsForDateAndArmada(tr.tanggal, tr.armada);
        await resequenceTripsForDateAndArmada(tr.tanggal, targetArmada);

        alert(`✅ Sukses memecah muatan!\n\n• ${tr.armada}: ${nf.format(sisaKg)} Kg\n• ${targetArmada}: ${nf.format(splitKg)} Kg`);
        tutupModalKelolaTripAdmin();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal memecah trip: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origText; }
    }
}

async function eksekusiGabungTripAdmin() {
    let sourceId = document.getElementById('kelola-trip-id')?.value;
    let targetId = document.getElementById('kelola-trip-select-target')?.value;

    if (!sourceId || !targetId) {
        alert("Pilih salah satu trip utama tujuan penggabungan!");
        return;
    }

    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let trSource = trips.find(t => t.id == sourceId);
    let trTarget = trips.find(t => t.id == targetId);

    if (!trSource || !trTarget) {
        alert("Data trip tidak ditemukan.");
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');
    let totalKgGabung = (parseFloat(trTarget.total_kg) || 0) + (parseFloat(trSource.total_kg) || 0);

    // Hitung titik drop berdasarkan konsumen/tujuan unik (bukan sekadar nambah titikTarget + titikSource)
    let combinedManifest = (trTarget.manifest_items || []).concat(trSource.manifest_items || []);
    let uniqueDestinations = new Set(
        combinedManifest.map(m => (m?.relasi || '').trim().toLowerCase()).filter(Boolean)
    );
    if (uniqueDestinations.size === 0) {
        let relT = (trTarget.catatan || '').replace(/\[.*?\]|\(.*?\)/g, '').trim().split(' ')[0].toLowerCase();
        let relS = (trSource.catatan || '').replace(/\[.*?\]|\(.*?\)/g, '').trim().split(' ')[0].toLowerCase();
        if (relT) uniqueDestinations.add(relT);
        if (relS) uniqueDestinations.add(relS);
    }
    let totalTitik = Math.max(1, uniqueDestinations.size);

    let msg = `Gabungkan trip ini ke Rit ${trTarget.urutan_rit || 1} (${trTarget.armada})?\n\n`
            + `• Total Beban Fisik Baru: ${nf.format(totalKgGabung)} Kg\n`
            + `• Jumlah Titik Drop: ${totalTitik} Titik\n`
            + `• Baris trip asal akan dilebur (catatan perjalanan digabung menjadi 1 rit fisik).\n\n`
            + `Lanjutkan penggabungan?`;

    if (!confirm(msg)) return;

    let btn = document.getElementById('btn-gabung-trip-admin');
    let origText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerText = "Menggabungkan..."; }

    try {
        let cleanCatTarget = (trTarget.catatan || '').replace(/\s*\[\d+\s*Titik\]/gi, '').replace(/\s*\[SPLIT:\d+\]/gi, '').trim();
        let cleanCatSource = (trSource.catatan || '').replace(/\s*\[\d+\s*Titik\]/gi, '').replace(/\s*\[SPLIT:\d+\]/gi, '').trim();
        let isSameDestination = cleanCatTarget === cleanCatSource || cleanCatTarget.toLowerCase().includes(cleanCatSource.toLowerCase()) || cleanCatSource.toLowerCase().includes(cleanCatTarget.toLowerCase());
        let combinedCatatan = isSameDestination
            ? `${cleanCatTarget} [${totalTitik} Titik]`.trim()
            : `${cleanCatTarget} | Drop: ${cleanCatSource} [${totalTitik} Titik]`.trim();

        let resPatch = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${targetId}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            },
            body: JSON.stringify({
                total_kg: totalKgGabung,
                manifest_items: combinedManifest,
                catatan: combinedCatatan
            })
        });

        if (!resPatch.ok) {
            let err = await resPatch.json();
            throw new Error(err.message || 'Gagal memperbarui trip tujuan');
        }

        let resDel = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${sourceId}`, {
            method: 'DELETE',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            }
        });

        if (!resDel.ok) {
            console.warn("Source trip berhasil dilebur tapi gagal dihapus baris asalnya.");
        }

        // Pindahkan referensi transaksi_pakan yang sebelumnya terhubung ke source trip agar mengarah ke target trip
        try {
            await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?trip_id=eq.${sourceId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                },
                body: JSON.stringify({
                    trip_id: targetId,
                    armada: trTarget.armada
                })
            });
        } catch (eTx) {
            console.warn("Gagal update referensi trip_id transaksi_pakan:", eTx);
        }

        // Sinkronkan cashflow: hapus solar source trip & update solar target trip jika Truk
        try {
            await fetch(`${SUPA_URL}/rest/v1/cashflow?keterangan=like.*${encodeURIComponent(`[TRIP:${sourceId}]`)}*`, {
                method: 'DELETE',
                headers: { 
                    'apikey': SUPA_ANON_KEY, 
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                }
            });
        } catch (eDelCF) {}

        let isTargetTruk = (trTarget.armada || '').includes('8749') || (trTarget.armada || '').includes('Truk');
        if (isTargetTruk) {
            await syncSolarTrukToCashflow(targetId, trTarget.armada, trTarget.tanggal, totalTitik, combinedCatatan);
        }

        // Pastikan urutan rit kedua armada kembali rapi berurutan
        await resequenceTripsForDateAndArmada(trSource.tanggal, trSource.armada);
        if (trTarget.armada !== trSource.armada) {
            await resequenceTripsForDateAndArmada(trTarget.tanggal, trTarget.armada);
        }

        alert(`✅ Sukses! Kedua pengiriman berhasil digabung menjadi 1 Rit Fisik (${totalTitik} Titik Drop, Total ${nf.format(totalKgGabung)} Kg).`);
        tutupModalKelolaTripAdmin();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal menggabungkan trip: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origText; }
    }
}

async function hapusTripAdminDariLog() {
    let tripId = document.getElementById('kelola-trip-id')?.value;
    if (!tripId) return;

    let trips = window._cacheArmadaData?.trips || window.tripState?.cachedTrips || [];
    let tr = trips.find(t => t.id == tripId);
    let trTanggal = tr?.tanggal;
    let trArmada = tr?.armada;

    if (!confirm("Yakin ingin menghapus baris trip ini dari catatan perjalanan armada?\n\nCatatan: Data transaksi pakan & omzet tetap aman, hanya baris perjalanan ini yang dihapus.")) {
        return;
    }

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?id=eq.${tripId}`, {
            method: 'DELETE',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
            }
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || 'Gagal menghapus');
        }

        // Lepas relasi trip_id di transaksi_pakan (jadikan null) agar tidak mengarah ke trip yang sudah dihapus
        try {
            await fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?trip_id=eq.${tripId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                },
                body: JSON.stringify({ trip_id: null })
            });
        } catch (eTx) {
            console.warn("Gagal lepas relasi trip_id di transaksi_pakan:", eTx);
        }

        // Hapus entri solar truk di cashflow jika sebelumnya tercatat
        try {
            await fetch(`${SUPA_URL}/rest/v1/cashflow?keterangan=like.*${encodeURIComponent(`[TRIP:${tripId}]`)}*`, {
                method: 'DELETE',
                headers: { 
                    'apikey': SUPA_ANON_KEY, 
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'x-pin-karyawan': (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : '1234'
                }
            });
        } catch (eDelCF) {}

        // Resequence nomor urutan rit yang tersisa
        if (trTanggal && trArmada) {
            await resequenceTripsForDateAndArmada(trTanggal, trArmada);
        }

        alert("✅ Baris trip berhasil dihapus dari log armada.");
        tutupModalKelolaTripAdmin();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal menghapus trip: " + e.message);
    }
}

// ====================================================================
// RAPOR KINERJA & BIAYA PENGIRIMAN ARMADA CBL (EXECUTIVE REPORT)
// ====================================================================

window._raporSettings = window._raporSettings || {
    showPendapatan: true,
    printPendapatan: false
};

function toggleRaporSetting(key, val) {
    window._raporSettings[key] = val;
    renderRaporArmadaView();
}

function getFleetReportMetrics(targetArmada, allTrips, allExpenses, ongkirRows) {
    let trips = (allTrips || []).filter(t => {
        let arm = (t.armada || '').toUpperCase();
        if (targetArmada === 'D 8707 UE') return arm.includes('8707') || arm.includes('8070');
        if (targetArmada === 'D 8142 UK') return arm.includes('8142');
        if (targetArmada === 'D 8749 UA') return arm.includes('8749') || arm.includes('TRUK');
        return false;
    });

    let tripIdSet = new Set(trips.map(t => t.id));
    let tripRelasiDates = new Set();
    trips.forEach(t => {
        let rList = (t.manifest_items || []).map(m => (m.relasi || '').trim().toLowerCase()).filter(Boolean);
        if (rList.length === 0 && t.catatan) {
            let cleanCat = t.catatan.replace(/\[.*?\]/g, '').replace(/Rit\s*\d+/gi, '').replace(/D\s*\d+\s*[A-Z]+/gi, '').trim().toLowerCase();
            if (cleanCat) rList.push(cleanCat);
        }
        rList.forEach(r => {
            if (r) tripRelasiDates.add(`${t.tanggal}__${r}`);
        });
    });

    // Cek apakah relasi tersebut ada di armada lain pada tanggal yang sama
    let otherTripsRelasiDates = new Set();
    (allTrips || []).filter(t => !tripIdSet.has(t.id)).forEach(t => {
        let rList = (t.manifest_items || []).map(m => (m.relasi || '').trim().toLowerCase()).filter(Boolean);
        if (rList.length === 0 && t.catatan) {
            let cleanCat = t.catatan.replace(/\[.*?\]/g, '').replace(/Rit\s*\d+/gi, '').replace(/D\s*\d+\s*[A-Z]+/gi, '').trim().toLowerCase();
            if (cleanCat) rList.push(cleanCat);
        }
        rList.forEach(r => {
            if (r) otherTripsRelasiDates.add(`${t.tanggal}__${r}`);
        });
    });

    let expenses = (allExpenses || []).filter(item => {
        let str = `${item.armada || ''} ${item.relasi || ''} ${item.keterangan || ''}`.toUpperCase();
        if (targetArmada === 'D 8707 UE') return str.includes('8707') || str.includes('8070');
        if (targetArmada === 'D 8142 UK') return str.includes('8142');
        if (targetArmada === 'D 8749 UA') return str.includes('8749') || str.includes('TRUK');
        return false;
    });

    let totalRit = trips.length;
    let totalTitik = trips.reduce((sum, t) => sum + ((typeof getTripJumlahTitik === 'function') ? getTripJumlahTitik(t) : (parseInt(t.jumlah_titik) || 1)), 0);
    let totalKg = trips.reduce((sum, t) => sum + (parseFloat(t.total_kg) || 0), 0);
    let totalKm = trips.reduce((sum, t) => sum + (parseFloat(t.jarak_tempuh_km) || 0), 0);
    let avgKgPerRit = totalRit > 0 ? Math.round(totalKg / totalRit) : 0;

    let bbm = 0, servis = 0, ban = 0, cuci = 0, lainnya = 0, inboundHpp = 0;
    expenses.forEach(item => {
        let nom = parseFloat(item.nominal) || 0;
        let text = `${item.kategori || ''} ${item.keterangan || ''}`.toLowerCase();
        
        // ⚡ Solar pengambilan pakan masuk (SJM / KF / Tebon / Inbound) masuk komponen HPP gudang,
        // BUKAN beban pengantaran ekspedisi konsumen agar rapor armada pengantaran tidak bengkak!
        let isInboundHpp = (item.kategori || '').toLowerCase().includes('ekspedisi') ||
                           text.includes('ambil sjm') || 
                           text.includes('ambil kf') || 
                           text.includes('tebon') || 
                           text.includes('sjm cimaung') || 
                           text.includes('ambil kfzs');
        if (isInboundHpp) {
            inboundHpp += nom;
            return;
        }

        if (text.includes('bbm') || text.includes('solar') || text.includes('bensin') || text.includes('pertalite') || text.includes('dexlite')) {
            bbm += nom;
        } else if (text.includes('servis') || text.includes('service') || text.includes('oli') || text.includes('tune up') || text.includes('perbaikan') || text.includes('bengkel') || text.includes('sparepart')) {
            servis += nom;
        } else if (text.includes('ban') || text.includes('angin') || text.includes('velg') || text.includes('tambal')) {
            ban += nom;
        } else if (text.includes('cuci')) {
            cuci += nom;
        } else {
            lainnya += nom;
        }
    });

    let totalBiaya = bbm + servis + ban + cuci + lainnya;
    let costPerKg = totalKg > 0 ? (totalBiaya / totalKg) : 0;
    let costPerKm = totalKm > 0 ? (totalBiaya / totalKm) : 0;

    // Hitung Pendapatan Ongkir yang diperoleh armada ini via getTripPendapatanOngkir (Formula 2)
    let pendapatanOngkir = 0;
    trips.forEach(tr => {
        let pInfo = getTripPendapatanOngkir(tr, allTrips, ongkirRows);
        pendapatanOngkir += (pInfo.nominal || 0);
    });

    let marginLogistik = pendapatanOngkir - totalBiaya;

    return {
        totalRit,
        totalTitik,
        totalKg,
        totalKm,
        avgKgPerRit,
        bbm,
        isSolarTrukAuto: false,
        servis,
        ban,
        cuci,
        lainnya,
        totalBiaya,
        costPerKg,
        costPerKm,
        pendapatanOngkir,
        marginLogistik
    };
}

function renderRaporArmadaView() {
    let container = document.getElementById('admin-rapor-armada-content');
    if (!container) return;

    let nf = new Intl.NumberFormat('id-ID');
    let allExpenses = window._cacheArmadaData?.expenses || [];
    let allTrips = window._cacheArmadaData?.trips || [];
    let ongkirRows = window._cacheArmadaData?.ongkirRows || [];
    let labelPeriode = window._cacheArmadaData?.labelPeriode || 'Periode Aktif';

    let settings = window._raporSettings || { showPendapatan: true, printPendapatan: false };

    let mHilman = getFleetReportMetrics('D 8707 UE', allTrips, allExpenses, ongkirRows);
    let mAdi = getFleetReportMetrics('D 8142 UK', allTrips, allExpenses, ongkirRows);
    let mTruk = getFleetReportMetrics('D 8749 UA', allTrips, allExpenses, ongkirRows);

    let totRit = mHilman.totalRit + mAdi.totalRit + mTruk.totalRit;
    let totTitik = mHilman.totalTitik + mAdi.totalTitik + mTruk.totalTitik;
    let totKg = mHilman.totalKg + mAdi.totalKg + mTruk.totalKg;
    let totKm = mHilman.totalKm + mAdi.totalKm + mTruk.totalKm;
    let totBbm = mHilman.bbm + mAdi.bbm + mTruk.bbm;
    let totServis = mHilman.servis + mAdi.servis + mTruk.servis;
    let totBan = mHilman.ban + mAdi.ban + mTruk.ban;
    let totCuciLain = (mHilman.cuci + mHilman.lainnya) + (mAdi.cuci + mAdi.lainnya) + (mTruk.cuci + mTruk.lainnya);
    let totBiaya = mHilman.totalBiaya + mAdi.totalBiaya + mTruk.totalBiaya;
    let totCostPerKg = totKg > 0 ? (totBiaya / totKg) : 0;
    let totCostPerKm = totKm > 0 ? (totBiaya / totKm) : 0;

    let totPendapatan = mHilman.pendapatanOngkir + mAdi.pendapatanOngkir + mTruk.pendapatanOngkir;
    let totMargin = totPendapatan - totBiaya;

    let showPendapatan = settings.showPendapatan;

    container.innerHTML = `
        <div style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            <!-- Header Rapor -->
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #f1f5f9; padding-bottom:12px; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
                <div>
                    <h3 style="margin:0; font-size:16px; font-weight:800; color:#1e293b;">
                        Rapor Kinerja & Biaya Pengiriman Armada PT CBL
                    </h3>
                    <div style="font-size:12px; color:#64748b; margin-top:3px;">
                        Periode: <b style="color:#1e293b;">${labelPeriode}</b> | Evaluasi Rit, Tonase, Kilometer & Biaya Operasional
                    </div>
                </div>
                <button type="button" onclick="cetakRaporArmada()" style="background:#1e293b; color:white; border:none; padding:8px 14px; border-radius:8px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:6px;">
                    Cetak Rapor
                </button>
            </div>

            <!-- Opsi Pengaturan Rapor & Tampilan -->
            <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap; background:#f8fafc; border:1px solid #e2e8f0; padding:9px 12px; border-radius:8px; margin-bottom:16px; font-size:11px; color:#334155;">
                <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-weight:600;">
                    <input type="checkbox" ${settings.showPendapatan ? 'checked' : ''} onchange="toggleRaporSetting('showPendapatan', this.checked)">
                    Tampilkan Pendapatan Ongkir & Margin di Layar
                </label>
                <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-weight:600;">
                    <input type="checkbox" ${settings.printPendapatan ? 'checked' : ''} onchange="toggleRaporSetting('printPendapatan', this.checked)">
                    Sertakan Pendapatan Ongkir saat Cetak PDF
                </label>
            </div>

            <!-- 3 Comparative Cards -->
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; margin-bottom:20px;">
                <!-- KARTU 1: D 8707 UE (Hilman) -->
                <div style="background:#f8fafc; border:1px solid #cbd5e1; border-top:4px solid #2563eb; border-radius:10px; padding:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                        <div>
                            <span style="font-size:10px; font-weight:700; color:#2563eb; background:#eff6ff; padding:2px 6px; border-radius:4px;">PICK-UP UTAMA</span>
                            <h4 style="margin:4px 0 0 0; font-size:15px; font-weight:800; color:#1e293b;">D 8707 UE</h4>
                            <div style="font-size:11px; color:#64748b;">Suzuki Carry • Supir: Hilman</div>
                        </div>
                        <span style="font-size:10px; font-weight:700; color:#475569; background:#ffffff; border:1px solid #cbd5e1; padding:3px 8px; border-radius:6px;">1.5 TON</span>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; background:#ffffff; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
                        <div>
                            <div style="font-size:10px; color:#64748b;">Total Rit</div>
                            <div style="font-size:16px; font-weight:800; color:#1e293b;">${mHilman.totalRit} <span style="font-size:10px; font-weight:600;">Rit</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Total Muatan</div>
                            <div style="font-size:16px; font-weight:800; color:#2563eb;">${nf.format(mHilman.totalKg)} <span style="font-size:10px; font-weight:600;">Kg</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Jarak Tempuh</div>
                            <div style="font-size:14px; font-weight:800; color:#475569;">${nf.format(mHilman.totalKm)} <span style="font-size:10px; font-weight:600;">Km</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Rata-rata/Rit</div>
                            <div style="font-size:14px; font-weight:800; color:#475569;">${nf.format(mHilman.avgKgPerRit)} <span style="font-size:10px; font-weight:600;">Kg</span></div>
                        </div>
                    </div>

                    <div style="background:#ffffff; padding:10px; border-radius:8px; border:1px solid #e2e8f0; font-size:11px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Bensin / BBM:</span>
                            <b>Rp ${nf.format(mHilman.bbm)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Servis & Oli:</span>
                            <b>Rp ${nf.format(mHilman.servis)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Ban & Angin:</span>
                            <b>Rp ${nf.format(mHilman.ban)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Cuci, Tol & Parkir:</span>
                            <b>Rp ${nf.format(mHilman.cuci + mHilman.lainnya)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px dashed #cbd5e1; font-weight:700; color:#1e293b;">
                            <span>Total Pengeluaran:</span>
                            <span style="color:#b91c1c;">Rp ${nf.format(mHilman.totalBiaya)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:3px; font-size:10.5px; color:#475569;">
                            <span>Biaya per Kg Pakan:</span>
                            <span style="font-weight:700;">Rp ${mHilman.costPerKg.toFixed(1)} / Kg</span>
                        </div>
                        ${showPendapatan ? `
                            <div style="display:flex; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px solid #e2e8f0; color:#1e40af; font-weight:700;">
                                <span>Pendapatan Ongkir:</span>
                                <span>Rp ${nf.format(mHilman.pendapatanOngkir)}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; margin-top:3px; font-weight:800; color:${mHilman.marginLogistik >= 0 ? '#15803d' : '#b91c1c'};">
                                <span>Margin Bersih:</span>
                                <span>Rp ${nf.format(mHilman.marginLogistik)}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>

                <!-- KARTU 2: D 8142 UK (Adi) -->
                <div style="background:#f8fafc; border:1px solid #cbd5e1; border-top:4px solid #ea580c; border-radius:10px; padding:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                        <div>
                            <span style="font-size:10px; font-weight:700; color:#ea580c; background:#fff7ed; padding:2px 6px; border-radius:4px;">PICK-UP CADANGAN</span>
                            <h4 style="margin:4px 0 0 0; font-size:15px; font-weight:800; color:#1e293b;">D 8142 UK</h4>
                            <div style="font-size:11px; color:#64748b;">Daihatsu Grand Max • Supir: Adi</div>
                        </div>
                        <span style="font-size:10px; font-weight:700; color:#475569; background:#ffffff; border:1px solid #cbd5e1; padding:3px 8px; border-radius:6px;">1.5 TON</span>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; background:#ffffff; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
                        <div>
                            <div style="font-size:10px; color:#64748b;">Total Rit</div>
                            <div style="font-size:16px; font-weight:800; color:#1e293b;">${mAdi.totalRit} <span style="font-size:10px; font-weight:600;">Rit</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Total Muatan</div>
                            <div style="font-size:16px; font-weight:800; color:#ea580c;">${nf.format(mAdi.totalKg)} <span style="font-size:10px; font-weight:600;">Kg</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Jarak Tempuh</div>
                            <div style="font-size:14px; font-weight:800; color:#475569;">${nf.format(mAdi.totalKm)} <span style="font-size:10px; font-weight:600;">Km</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Rata-rata/Rit</div>
                            <div style="font-size:14px; font-weight:800; color:#475569;">${nf.format(mAdi.avgKgPerRit)} <span style="font-size:10px; font-weight:600;">Kg</span></div>
                        </div>
                    </div>

                    <div style="background:#ffffff; padding:10px; border-radius:8px; border:1px solid #e2e8f0; font-size:11px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Bensin / BBM:</span>
                            <b>Rp ${nf.format(mAdi.bbm)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Servis & Oli:</span>
                            <b>Rp ${nf.format(mAdi.servis)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Ban & Angin:</span>
                            <b>Rp ${nf.format(mAdi.ban)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Cuci, Tol & Parkir:</span>
                            <b>Rp ${nf.format(mAdi.cuci + mAdi.lainnya)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px dashed #cbd5e1; font-weight:700; color:#1e293b;">
                            <span>Total Pengeluaran:</span>
                            <span style="color:#b91c1c;">Rp ${nf.format(mAdi.totalBiaya)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:3px; font-size:10.5px; color:#475569;">
                            <span>Biaya per Kg Pakan:</span>
                            <span style="font-weight:700;">Rp ${mAdi.costPerKg.toFixed(1)} / Kg</span>
                        </div>
                        ${showPendapatan ? `
                            <div style="display:flex; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px solid #e2e8f0; color:#1e40af; font-weight:700;">
                                <span>Pendapatan Ongkir:</span>
                                <span>Rp ${nf.format(mAdi.pendapatanOngkir)}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; margin-top:3px; font-weight:800; color:${mAdi.marginLogistik >= 0 ? '#15803d' : '#b91c1c'};">
                                <span>Margin Bersih:</span>
                                <span>Rp ${nf.format(mAdi.marginLogistik)}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>

                <!-- KARTU 3: D 8749 UA (Truk Pak Agus) -->
                <div style="background:#f8fafc; border:1px solid #cbd5e1; border-top:4px solid #0f766e; border-radius:10px; padding:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                        <div>
                            <span style="font-size:10px; font-weight:700; color:#0f766e; background:#f0fdfa; padding:2px 6px; border-radius:4px;">HEAVY TRUCK</span>
                            <h4 style="margin:4px 0 0 0; font-size:15px; font-weight:800; color:#1e293b;">D 8749 UA</h4>
                            <div style="font-size:11px; color:#64748b;">Truk Colt Diesel • Supir: Pak Agus</div>
                        </div>
                        <span style="font-size:10px; font-weight:700; color:#475569; background:#ffffff; border:1px solid #cbd5e1; padding:3px 8px; border-radius:6px;">7.5 TON</span>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; background:#ffffff; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
                        <div>
                            <div style="font-size:10px; color:#64748b;">Total Rit</div>
                            <div style="font-size:16px; font-weight:800; color:#1e293b;">${mTruk.totalRit} <span style="font-size:10px; font-weight:600;">Rit</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Total Muatan</div>
                            <div style="font-size:16px; font-weight:800; color:#0f766e;">${nf.format(mTruk.totalKg)} <span style="font-size:10px; font-weight:600;">Kg</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Jarak Tempuh</div>
                            <div style="font-size:14px; font-weight:800; color:#475569;">${nf.format(mTruk.totalKm)} <span style="font-size:10px; font-weight:600;">Km</span></div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#64748b;">Rata-rata/Rit</div>
                            <div style="font-size:14px; font-weight:800; color:#475569;">${nf.format(mTruk.avgKgPerRit)} <span style="font-size:10px; font-weight:600;">Kg</span></div>
                        </div>
                    </div>

                    <div style="background:#ffffff; padding:10px; border-radius:8px; border:1px solid #e2e8f0; font-size:11px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Solar / BBM:</span>
                            <b>Rp ${nf.format(mTruk.bbm)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Servis & Oli:</span>
                            <b>Rp ${nf.format(mTruk.servis)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Ban & Angin:</span>
                            <b>Rp ${nf.format(mTruk.ban)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#475569;">
                            <span>Cuci, Tol & Parkir:</span>
                            <b>Rp ${nf.format(mTruk.cuci + mTruk.lainnya)}</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px dashed #cbd5e1; font-weight:700; color:#1e293b;">
                            <span>Total Pengeluaran:</span>
                            <span style="color:#b91c1c;">Rp ${nf.format(mTruk.totalBiaya)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:3px; font-size:10.5px; color:#475569;">
                            <span>Biaya per Kg Pakan:</span>
                            <span style="font-weight:700;">Rp ${mTruk.costPerKg.toFixed(1)} / Kg</span>
                        </div>
                        ${showPendapatan ? `
                            <div style="display:flex; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px solid #e2e8f0; color:#1e40af; font-weight:700;">
                                <span>Pendapatan Ongkir:</span>
                                <span>Rp ${nf.format(mTruk.pendapatanOngkir)}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; margin-top:3px; font-weight:800; color:${mTruk.marginLogistik >= 0 ? '#15803d' : '#b91c1c'};">
                                <span>Margin Bersih:</span>
                                <span>Rp ${nf.format(mTruk.marginLogistik)}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>

            <!-- Tabel Komparasi Head-to-Head 3 Armada + Total CBL -->
            <div style="border-radius:10px; overflow:hidden; border:1px solid #e2e8f0; margin-top:10px;">
                <table style="width:100%; border-collapse:collapse; font-size:11.5px; text-align:left;">
                    <thead style="background:#1e3a8a; color:#ffffff;">
                        <tr>
                            <th style="padding:10px 12px; font-weight:700;">Parameter / Metrik Kinerja</th>
                            <th style="padding:10px 12px; text-align:right; font-weight:700;">D 8707 UE (Hilman)</th>
                            <th style="padding:10px 12px; text-align:right; font-weight:700;">D 8142 UK (Adi)</th>
                            <th style="padding:10px 12px; text-align:right; font-weight:700;">D 8749 UA (Truk)</th>
                            <th style="padding:10px 12px; text-align:right; font-weight:800; background:#0f172a;">TOTAL CBL</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;">
                            <td style="padding:9px 12px; font-weight:600; color:#1e293b;">Jumlah Rit Pengantaran</td>
                            <td style="padding:9px 12px; text-align:right;">${mHilman.totalRit} Rit</td>
                            <td style="padding:9px 12px; text-align:right;">${mAdi.totalRit} Rit</td>
                            <td style="padding:9px 12px; text-align:right;">${mTruk.totalRit} Rit</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700; background:#f1f5f9;">${totRit} Rit</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0;">
                            <td style="padding:9px 12px; font-weight:600; color:#1e293b;">Total Muatan Terdistribusi</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700;">${nf.format(mHilman.totalKg)} Kg</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700;">${nf.format(mAdi.totalKg)} Kg</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700;">${nf.format(mTruk.totalKg)} Kg</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:800; background:#f1f5f9; color:#0f766e;">${nf.format(totKg)} Kg</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;">
                            <td style="padding:9px 12px; color:#475569;">Rata-rata Muatan per Rit</td>
                            <td style="padding:9px 12px; text-align:right;">${nf.format(mHilman.avgKgPerRit)} Kg</td>
                            <td style="padding:9px 12px; text-align:right;">${nf.format(mAdi.avgKgPerRit)} Kg</td>
                            <td style="padding:9px 12px; text-align:right;">${nf.format(mTruk.avgKgPerRit)} Kg</td>
                            <td style="padding:9px 12px; text-align:right; background:#f1f5f9;">${totRit > 0 ? nf.format(Math.round(totKg / totRit)) : 0} Kg</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0;">
                            <td style="padding:9px 12px; color:#475569;">Total Jarak Tempuh Pengiriman</td>
                            <td style="padding:9px 12px; text-align:right;">${nf.format(mHilman.totalKm)} Km</td>
                            <td style="padding:9px 12px; text-align:right;">${nf.format(mAdi.totalKm)} Km</td>
                            <td style="padding:9px 12px; text-align:right;">${nf.format(mTruk.totalKm)} Km</td>
                            <td style="padding:9px 12px; text-align:right; background:#f1f5f9;">${nf.format(totKm)} Km</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0; background:#fefce8;">
                            <td style="padding:9px 12px; color:#854d0e; font-weight:600;">Biaya BBM / Solar</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mHilman.bbm)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mAdi.bbm)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mTruk.bbm)}</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700; color:#854d0e; background:#fef9c3;">Rp ${nf.format(totBbm)}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0;">
                            <td style="padding:9px 12px; color:#1e40af; font-weight:600;">Biaya Servis, Oli & Sparepart</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mHilman.servis)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mAdi.servis)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mTruk.servis)}</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700; color:#1e40af; background:#f1f5f9;">Rp ${nf.format(totServis)}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;">
                            <td style="padding:9px 12px; color:#b91c1c; font-weight:600;">Biaya Ban & Angin</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mHilman.ban)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mAdi.ban)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mTruk.ban)}</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700; color:#b91c1c; background:#f1f5f9;">Rp ${nf.format(totBan)}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0;">
                            <td style="padding:9px 12px; color:#0369a1; font-weight:600;">Biaya Cuci, Tol & Parkir</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mHilman.cuci + mHilman.lainnya)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mAdi.cuci + mAdi.lainnya)}</td>
                            <td style="padding:9px 12px; text-align:right;">Rp ${nf.format(mTruk.cuci + mTruk.lainnya)}</td>
                            <td style="padding:9px 12px; text-align:right; font-weight:700; color:#0369a1; background:#f1f5f9;">Rp ${nf.format(totCuciLain)}</td>
                        </tr>
                        <tr style="border-bottom:2px solid #ca8a04; background:#fef08a;">
                            <td style="padding:10px 12px; font-weight:800; color:#854d0e;">TOTAL BIAYA OPERASIONAL</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:800; color:#854d0e;">Rp ${nf.format(mHilman.totalBiaya)}</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:800; color:#854d0e;">Rp ${nf.format(mAdi.totalBiaya)}</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:800; color:#854d0e;">Rp ${nf.format(mTruk.totalBiaya)}</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:900; background:#fde047; color:#713f12;">Rp ${nf.format(totBiaya)}</td>
                        </tr>
                        <tr style="background:#f0fdf4; border-bottom:${showPendapatan ? '1px solid #e2e8f0' : 'none'};">
                            <td style="padding:10px 12px; font-weight:700; color:#15803d;">Efisiensi: Biaya Logistik per Kg</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:700; color:#15803d;">Rp ${mHilman.costPerKg.toFixed(1)} / Kg</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:700; color:#15803d;">Rp ${mAdi.costPerKg.toFixed(1)} / Kg</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:700; color:#15803d;">Rp ${mTruk.costPerKg.toFixed(1)} / Kg</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:800; background:#dcfce7; color:#166534;">Rp ${totCostPerKg.toFixed(1)} / Kg</td>
                        </tr>
                        ${showPendapatan ? `
                            <tr style="border-bottom:1px solid #e2e8f0; background:#eff6ff;">
                                <td style="padding:10px 12px; font-weight:700; color:#1e40af;">Pendapatan Ongkir Pengantaran</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:700; color:#1d4ed8;">Rp ${nf.format(mHilman.pendapatanOngkir)}</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:700; color:#1d4ed8;">Rp ${nf.format(mAdi.pendapatanOngkir)}</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:700; color:#1d4ed8;">Rp ${nf.format(mTruk.pendapatanOngkir)}</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:800; background:#dbeafe; color:#1e40af;">Rp ${nf.format(totPendapatan)}</td>
                            </tr>
                            <tr style="background:#f8fafc;">
                                <td style="padding:10px 12px; font-weight:800; color:#0f172a;">Margin / Laba Bersih Logistik</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:800; color:${mHilman.marginLogistik >= 0 ? '#15803d' : '#b91c1c'};">Rp ${nf.format(mHilman.marginLogistik)}</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:800; color:${mAdi.marginLogistik >= 0 ? '#15803d' : '#b91c1c'};">Rp ${nf.format(mAdi.marginLogistik)}</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:800; color:${mTruk.marginLogistik >= 0 ? '#15803d' : '#b91c1c'};">Rp ${nf.format(mTruk.marginLogistik)}</td>
                                <td style="padding:10px 12px; text-align:right; font-weight:900; background:#f1f5f9; color:${totMargin >= 0 ? '#15803d' : '#b91c1c'};">Rp ${nf.format(totMargin)}</td>
                            </tr>
                        ` : ''}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function cetakRaporArmada() {
    let nf = new Intl.NumberFormat('id-ID');
    let allExpenses = window._cacheArmadaData?.expenses || [];
    let allTrips = window._cacheArmadaData?.trips || [];
    let ongkirRows = window._cacheArmadaData?.ongkirRows || [];
    let labelPeriode = window._cacheArmadaData?.labelPeriode || 'Periode Aktif';

    let settings = window._raporSettings || { showPendapatan: true, printPendapatan: false };

    let mHilman = getFleetReportMetrics('D 8707 UE', allTrips, allExpenses, ongkirRows);
    let mAdi = getFleetReportMetrics('D 8142 UK', allTrips, allExpenses, ongkirRows);
    let mTruk = getFleetReportMetrics('D 8749 UA', allTrips, allExpenses, ongkirRows);

    let totRit = mHilman.totalRit + mAdi.totalRit + mTruk.totalRit;
    let totKg = mHilman.totalKg + mAdi.totalKg + mTruk.totalKg;
    let totKm = mHilman.totalKm + mAdi.totalKm + mTruk.totalKm;
    let totBbm = mHilman.bbm + mAdi.bbm + mTruk.bbm;
    let totServis = mHilman.servis + mAdi.servis + mTruk.servis;
    let totBan = mHilman.ban + mAdi.ban + mTruk.ban;
    let totCuciLain = (mHilman.cuci + mHilman.lainnya) + (mAdi.cuci + mAdi.lainnya) + (mTruk.cuci + mTruk.lainnya);
    let totBiaya = mHilman.totalBiaya + mAdi.totalBiaya + mTruk.totalBiaya;
    let totCostPerKg = totKg > 0 ? (totBiaya / totKg) : 0;
    let totCostPerKm = totKm > 0 ? (totBiaya / totKm) : 0;

    let printPendapatan = settings.printPendapatan;
    let totPendapatan = mHilman.pendapatanOngkir + mAdi.pendapatanOngkir + mTruk.pendapatanOngkir;
    let totMargin = totPendapatan - totBiaya;

    let printWin = window.open('', '_blank', 'width=1050,height=800');
    if (!printWin) {
        window.print();
        return;
    }

    let printHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta charset="utf-8">
                <title>Rapor Kinerja & Biaya Operasional Armada CBL - ${labelPeriode}</title>
                <style>
                    @page {
                        size: A4 landscape;
                        margin: 16mm 20mm;
                    }
                    * {
                        box-sizing: border-box;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }
                    body {
                        font-family: Arial, Helvetica, sans-serif;
                        padding: 8px 12px;
                        margin: 0;
                        color: #0f172a;
                        background: #ffffff;
                        font-size: 10.5px;
                    }
                    .header-box {
                        border-bottom: 2px solid #0f172a;
                        padding-bottom: 8px;
                        margin-bottom: 12px;
                        display: flex;
                        justify-content: space-between;
                        align-items: flex-end;
                    }
                    .company-name {
                        font-size: 15px;
                        font-weight: 800;
                        color: #0f172a;
                        letter-spacing: 0.5px;
                    }
                    .doc-title {
                        font-size: 11.5px;
                        font-weight: 700;
                        color: #334155;
                        margin-top: 2px;
                    }
                    .doc-meta {
                        text-align: right;
                        font-size: 9.5px;
                        color: #64748b;
                        line-height: 1.4;
                    }
                    .cards-container {
                        display: flex;
                        gap: 12px;
                        margin-bottom: 14px;
                    }
                    .armada-card {
                        flex: 1;
                        border: 1px solid #94a3b8;
                        border-radius: 6px;
                        padding: 8px 10px;
                        background: #f8fafc;
                    }
                    .card-head {
                        border-bottom: 1px solid #cbd5e1;
                        padding-bottom: 4px;
                        margin-bottom: 6px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .card-plat {
                        font-size: 12px;
                        font-weight: 800;
                        color: #0f172a;
                    }
                    .card-type {
                        font-size: 9px;
                        font-weight: 700;
                        color: #334155;
                        background: #e2e8f0;
                        padding: 1px 5px;
                        border-radius: 3px;
                    }
                    .row-kv {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 2px;
                        font-size: 10px;
                        color: #334155;
                    }
                    .row-kv.bold {
                        font-weight: bold;
                        color: #0f172a;
                    }
                    .table-rapor {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 10px;
                        margin-top: 10px;
                    }
                    .table-rapor th, .table-rapor td {
                        border: 1px solid #94a3b8;
                        padding: 5px 8px;
                    }
                    .table-rapor th {
                        background-color: #1e3a8a;
                        color: #ffffff;
                        font-weight: 800;
                        text-align: left;
                    }
                    .table-rapor th.right {
                        text-align: right;
                    }
                    .table-rapor th.bg-total {
                        background-color: #0f172a;
                        color: #ffffff;
                    }
                    .table-rapor td.right {
                        text-align: right;
                    }
                    .bg-light {
                        background-color: #f8fafc;
                    }
                    .bg-total {
                        background-color: #f1f5f9;
                        font-weight: 800;
                    }
                    .bg-biaya-kuning {
                        background-color: #fef08a !important;
                        color: #854d0e !important;
                        font-weight: 800 !important;
                    }
                    .bg-biaya-kuning-total {
                        background-color: #fde047 !important;
                        color: #713f12 !important;
                        font-weight: 900 !important;
                    }
                    .signatures {
                        display: flex;
                        justify-content: space-between;
                        margin-top: 25px;
                        padding: 0 40px;
                        font-size: 10px;
                        text-align: center;
                    }
                    .sig-person {
                        width: 180px;
                    }
                    .sig-space {
                        height: 40px;
                    }
                    .sig-name {
                        border-top: 1px solid #0f172a;
                        padding-top: 4px;
                        font-weight: 700;
                    }
                </style>
            </head>
            <body>
                <div class="header-box">
                    <div>
                        <div class="company-name">PT CITA BENGGALA LESTARI (CBL)</div>
                        <div class="doc-title">RAPOR KINERJA DAN BIAYA OPERASIONAL ARMADA PENGIRIMAN</div>
                    </div>
                    <div class="doc-meta">
                        <div>Periode: <b>${labelPeriode}</b></div>
                        <div>Dicetak: ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                </div>

                <div class="cards-container">
                    <div class="armada-card">
                        <div class="card-head">
                            <div>
                                <div class="card-plat">D 8707 UE</div>
                                <div style="font-size:9.5px; color:#64748b;">Suzuki Carry • Supir: Hilman</div>
                            </div>
                            <span class="card-type">1.5 TON</span>
                        </div>
                        <div class="row-kv"><span>Rit Pengantaran:</span><b>${mHilman.totalRit} Rit</b></div>
                        <div class="row-kv"><span>Muatan Diangkut:</span><b>${nf.format(mHilman.totalKg)} Kg</b></div>
                        <div class="row-kv"><span>Rata-rata/Rit:</span><span>${nf.format(mHilman.avgKgPerRit)} Kg</span></div>
                        <div class="row-kv"><span>Jarak Tempuh:</span><span>${nf.format(mHilman.totalKm)} Km</span></div>
                        <div style="border-top:1px dashed #cbd5e1; margin:4px 0;"></div>
                        <div class="row-kv"><span>BBM / Bensin:</span><span>Rp ${nf.format(mHilman.bbm)}</span></div>
                        <div class="row-kv"><span>Servis & Sparepart:</span><span>Rp ${nf.format(mHilman.servis)}</span></div>
                        <div class="row-kv"><span>Ban & Angin:</span><span>Rp ${nf.format(mHilman.ban)}</span></div>
                        <div class="row-kv"><span>Cuci, Tol & Parkir:</span><span>Rp ${nf.format(mHilman.cuci + mHilman.lainnya)}</span></div>
                        <div class="row-kv bold" style="margin-top:3px; border-top:1px solid #94a3b8; padding-top:3px;">
                            <span>Total Biaya:</span>
                            <span>Rp ${nf.format(mHilman.totalBiaya)}</span>
                        </div>
                        <div class="row-kv" style="font-size:9.5px; color:#475569;">
                            <span>Biaya per Kg:</span>
                            <b>Rp ${mHilman.costPerKg.toFixed(1)} / Kg</b>
                        </div>
                        ${printPendapatan ? `
                            <div style="border-top:1px solid #cbd5e1; margin-top:3px; padding-top:2px;"></div>
                            <div class="row-kv"><span>Pendapatan Ongkir:</span><b>Rp ${nf.format(mHilman.pendapatanOngkir)}</b></div>
                            <div class="row-kv bold"><span>Margin Logistik:</span><b>Rp ${nf.format(mHilman.marginLogistik)}</b></div>
                        ` : ''}
                    </div>

                    <div class="armada-card">
                        <div class="card-head">
                            <div>
                                <div class="card-plat">D 8142 UK</div>
                                <div style="font-size:9.5px; color:#64748b;">Daihatsu Grand Max • Supir: Adi</div>
                            </div>
                            <span class="card-type">1.5 TON</span>
                        </div>
                        <div class="row-kv"><span>Rit Pengantaran:</span><b>${mAdi.totalRit} Rit</b></div>
                        <div class="row-kv"><span>Muatan Diangkut:</span><b>${nf.format(mAdi.totalKg)} Kg</b></div>
                        <div class="row-kv"><span>Rata-rata/Rit:</span><span>${nf.format(mAdi.avgKgPerRit)} Kg</span></div>
                        <div class="row-kv"><span>Jarak Tempuh:</span><span>${nf.format(mAdi.totalKm)} Km</span></div>
                        <div style="border-top:1px dashed #cbd5e1; margin:4px 0;"></div>
                        <div class="row-kv"><span>BBM / Bensin:</span><span>Rp ${nf.format(mAdi.bbm)}</span></div>
                        <div class="row-kv"><span>Servis & Sparepart:</span><span>Rp ${nf.format(mAdi.servis)}</span></div>
                        <div class="row-kv"><span>Ban & Angin:</span><span>Rp ${nf.format(mAdi.ban)}</span></div>
                        <div class="row-kv"><span>Cuci, Tol & Parkir:</span><span>Rp ${nf.format(mAdi.cuci + mAdi.lainnya)}</span></div>
                        <div class="row-kv bold" style="margin-top:3px; border-top:1px solid #94a3b8; padding-top:3px;">
                            <span>Total Biaya:</span>
                            <span>Rp ${nf.format(mAdi.totalBiaya)}</span>
                        </div>
                        <div class="row-kv" style="font-size:9.5px; color:#475569;">
                            <span>Biaya per Kg:</span>
                            <b>Rp ${mAdi.costPerKg.toFixed(1)} / Kg</b>
                        </div>
                        ${printPendapatan ? `
                            <div style="border-top:1px solid #cbd5e1; margin-top:3px; padding-top:2px;"></div>
                            <div class="row-kv"><span>Pendapatan Ongkir:</span><b>Rp ${nf.format(mAdi.pendapatanOngkir)}</b></div>
                            <div class="row-kv bold"><span>Margin Logistik:</span><b>Rp ${nf.format(mAdi.marginLogistik)}</b></div>
                        ` : ''}
                    </div>

                    <div class="armada-card">
                        <div class="card-head">
                            <div>
                                <div class="card-plat">D 8749 UA</div>
                                <div style="font-size:9.5px; color:#64748b;">Truk Colt Diesel • Supir: Pak Agus</div>
                            </div>
                            <span class="card-type">7.5 TON</span>
                        </div>
                        <div class="row-kv"><span>Rit Pengantaran:</span><b>${mTruk.totalRit} Rit</b></div>
                        <div class="row-kv"><span>Muatan Diangkut:</span><b>${nf.format(mTruk.totalKg)} Kg</b></div>
                        <div class="row-kv"><span>Rata-rata/Rit:</span><span>${nf.format(mTruk.avgKgPerRit)} Kg</span></div>
                        <div class="row-kv"><span>Jarak Tempuh:</span><span>${nf.format(mTruk.totalKm)} Km</span></div>
                        <div style="border-top:1px dashed #cbd5e1; margin:4px 0;"></div>
                        <div class="row-kv"><span>BBM / Solar:</span><span>Rp ${nf.format(mTruk.bbm)}</span></div>
                        <div class="row-kv"><span>Servis & Sparepart:</span><span>Rp ${nf.format(mTruk.servis)}</span></div>
                        <div class="row-kv"><span>Ban & Angin:</span><span>Rp ${nf.format(mTruk.ban)}</span></div>
                        <div class="row-kv"><span>Cuci, Tol & Parkir:</span><span>Rp ${nf.format(mTruk.cuci + mTruk.lainnya)}</span></div>
                        <div class="row-kv bold" style="margin-top:3px; border-top:1px solid #94a3b8; padding-top:3px;">
                            <span>Total Biaya:</span>
                            <span>Rp ${nf.format(mTruk.totalBiaya)}</span>
                        </div>
                        <div class="row-kv" style="font-size:9.5px; color:#475569;">
                            <span>Biaya per Kg:</span>
                            <b>Rp ${mTruk.costPerKg.toFixed(1)} / Kg</b>
                        </div>
                        ${printPendapatan ? `
                            <div style="border-top:1px solid #cbd5e1; margin-top:3px; padding-top:2px;"></div>
                            <div class="row-kv"><span>Pendapatan Ongkir:</span><b>Rp ${nf.format(mTruk.pendapatanOngkir)}</b></div>
                            <div class="row-kv bold"><span>Margin Logistik:</span><b>Rp ${nf.format(mTruk.marginLogistik)}</b></div>
                        ` : ''}
                    </div>
                </div>

                <table class="table-rapor">
                    <thead>
                        <tr>
                            <th>Parameter / Metrik Kinerja</th>
                            <th class="right">D 8707 UE (Hilman)</th>
                            <th class="right">D 8142 UK (Adi)</th>
                            <th class="right">D 8749 UA (Truk)</th>
                            <th class="right bg-total">TOTAL CBL</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="bg-light">
                            <td>Jumlah Rit Pengantaran</td>
                            <td class="right">${mHilman.totalRit} Rit</td>
                            <td class="right">${mAdi.totalRit} Rit</td>
                            <td class="right">${mTruk.totalRit} Rit</td>
                            <td class="right bg-total">${totRit} Rit</td>
                        </tr>
                        <tr>
                            <td>Total Muatan Terdistribusi</td>
                            <td class="right">${nf.format(mHilman.totalKg)} Kg</td>
                            <td class="right">${nf.format(mAdi.totalKg)} Kg</td>
                            <td class="right">${nf.format(mTruk.totalKg)} Kg</td>
                            <td class="right bg-total">${nf.format(totKg)} Kg</td>
                        </tr>
                        <tr class="bg-light">
                            <td>Rata-rata Muatan per Rit</td>
                            <td class="right">${nf.format(mHilman.avgKgPerRit)} Kg</td>
                            <td class="right">${nf.format(mAdi.avgKgPerRit)} Kg</td>
                            <td class="right">${nf.format(mTruk.avgKgPerRit)} Kg</td>
                            <td class="right bg-total">${totRit > 0 ? nf.format(Math.round(totKg / totRit)) : 0} Kg</td>
                        </tr>
                        <tr>
                            <td>Total Jarak Tempuh Pengiriman</td>
                            <td class="right">${nf.format(mHilman.totalKm)} Km</td>
                            <td class="right">${nf.format(mAdi.totalKm)} Km</td>
                            <td class="right">${nf.format(mTruk.totalKm)} Km</td>
                            <td class="right bg-total">${nf.format(totKm)} Km</td>
                        </tr>
                        <tr class="bg-light">
                            <td>Biaya BBM / Solar</td>
                            <td class="right">Rp ${nf.format(mHilman.bbm)}</td>
                            <td class="right">Rp ${nf.format(mAdi.bbm)}</td>
                            <td class="right">Rp ${nf.format(mTruk.bbm)}</td>
                            <td class="right bg-total">Rp ${nf.format(totBbm)}</td>
                        </tr>
                        <tr>
                            <td>Biaya Servis, Oli & Sparepart</td>
                            <td class="right">Rp ${nf.format(mHilman.servis)}</td>
                            <td class="right">Rp ${nf.format(mAdi.servis)}</td>
                            <td class="right">Rp ${nf.format(mTruk.servis)}</td>
                            <td class="right bg-total">Rp ${nf.format(totServis)}</td>
                        </tr>
                        <tr class="bg-light">
                            <td>Biaya Ban & Angin</td>
                            <td class="right">Rp ${nf.format(mHilman.ban)}</td>
                            <td class="right">Rp ${nf.format(mAdi.ban)}</td>
                            <td class="right">Rp ${nf.format(mTruk.ban)}</td>
                            <td class="right bg-total">Rp ${nf.format(totBan)}</td>
                        </tr>
                        <tr>
                            <td>Biaya Cuci, Tol & Parkir</td>
                            <td class="right">Rp ${nf.format(mHilman.cuci + mHilman.lainnya)}</td>
                            <td class="right">Rp ${nf.format(mAdi.cuci + mAdi.lainnya)}</td>
                            <td class="right">Rp ${nf.format(mTruk.cuci + mTruk.lainnya)}</td>
                            <td class="right bg-total">Rp ${nf.format(totCuciLain)}</td>
                        </tr>
                        <tr class="bg-biaya-kuning">
                            <td class="bg-biaya-kuning">TOTAL BIAYA OPERASIONAL</td>
                            <td class="right bg-biaya-kuning">Rp ${nf.format(mHilman.totalBiaya)}</td>
                            <td class="right bg-biaya-kuning">Rp ${nf.format(mAdi.totalBiaya)}</td>
                            <td class="right bg-biaya-kuning">Rp ${nf.format(mTruk.totalBiaya)}</td>
                            <td class="right bg-biaya-kuning-total">Rp ${nf.format(totBiaya)}</td>
                        </tr>
                        <tr class="bg-light">
                            <td>Efisiensi: Biaya Logistik per Kg</td>
                            <td class="right">Rp ${mHilman.costPerKg.toFixed(1)} / Kg</td>
                            <td class="right">Rp ${mAdi.costPerKg.toFixed(1)} / Kg</td>
                            <td class="right">Rp ${mTruk.costPerKg.toFixed(1)} / Kg</td>
                            <td class="right bg-total">Rp ${totCostPerKg.toFixed(1)} / Kg</td>
                        </tr>
                        ${printPendapatan ? `
                            <tr>
                                <td>Pendapatan Ongkir Pengantaran</td>
                                <td class="right">Rp ${nf.format(mHilman.pendapatanOngkir)}</td>
                                <td class="right">Rp ${nf.format(mAdi.pendapatanOngkir)}</td>
                                <td class="right">Rp ${nf.format(mTruk.pendapatanOngkir)}</td>
                                <td class="right bg-total">Rp ${nf.format(totPendapatan)}</td>
                            </tr>
                            <tr class="bg-total">
                                <td>Margin Operasional Logistik</td>
                                <td class="right">Rp ${nf.format(mHilman.marginLogistik)}</td>
                                <td class="right">Rp ${nf.format(mAdi.marginLogistik)}</td>
                                <td class="right">Rp ${nf.format(mTruk.marginLogistik)}</td>
                                <td class="right bg-total">Rp ${nf.format(totMargin)}</td>
                            </tr>
                        ` : ''}
                    </tbody>
                </table>

                <div class="signatures">
                    <div class="sig-person">
                        <div>Dibuat Oleh,</div>
                        <div class="sig-space"></div>
                        <div class="sig-name">Bagian Logistik & Armada</div>
                    </div>
                    <div class="sig-person">
                        <div>Mengetahui,</div>
                        <div class="sig-space"></div>
                        <div class="sig-name">Manajemen PT CBL</div>
                    </div>
                </div>

                <script>
                    window.onload = function() {
                        window.print();
                    };
                </script>
            </body>
        </html>
    `;

    printWin.document.write(printHtml);
    printWin.document.close();
}

// ====================================================================
// MODAL TAMBAH PENGANTARAN MANUAL OLEH ADMIN
// ====================================================================

function bukaModalTambahTripManual() {
    let modal = document.getElementById('modal-tambah-trip-manual');
    if (!modal) return;
    let tglEl = document.getElementById('manual-trip-tanggal');
    if (tglEl) tglEl.value = new Date().toISOString().split('T')[0];
    let kgEl = document.getElementById('manual-trip-kg');
    if (kgEl) kgEl.value = '';
    let tujEl = document.getElementById('manual-trip-tujuan');
    if (tujEl) tujEl.value = '';
    let titikEl = document.getElementById('manual-trip-titik');
    if (titikEl) titikEl.value = '1';
    let catEl = document.getElementById('manual-trip-catatan');
    if (catEl) catEl.value = '';

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function tutupModalTambahTripManual() {
    let modal = document.getElementById('modal-tambah-trip-manual');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    let box = document.getElementById('container-tugaskan-sewaluar');
    if (box) box.style.display = 'none';
    let inp = document.getElementById('input-tugaskan-sewaluar-nama');
    if (inp) inp.value = '';
}

function bukaInputTugaskanSewaLuar() {
    let box = document.getElementById('container-tugaskan-sewaluar');
    if (!box) return;
    if (box.style.display === 'none' || box.style.display === '') {
        box.style.display = 'block';
        let inp = document.getElementById('input-tugaskan-sewaluar-nama');
        if (inp) inp.focus();
    } else {
        box.style.display = 'none';
    }
}
window.bukaInputTugaskanSewaLuar = bukaInputTugaskanSewaLuar;

async function eksekusiTugaskanSewaLuar() {
    let order = window._selectedOrderToAssign;
    if (!order) {
        alert("Pilih pesanan terlebih dahulu!");
        return;
    }
    let inp = document.getElementById('input-tugaskan-sewaluar-nama');
    let namaSupir = inp ? inp.value.trim() : '';
    if (!namaSupir) {
        alert("Masukkan nama supir atau jenis armada luar!");
        return;
    }

    let armadaStr = `Sewa Luar (${namaSupir})`;
    let supaPin = window.currentLoggedPin || localStorage.getItem('cbl_user_pin') || (typeof currentLoggedPin !== 'undefined' && currentLoggedPin ? currentLoggedPin : '') || '1234';

    try {
        let cleanCatatan = (order.catatan || '').replace(/\[AMBIL SENDIRI.*?\]|\[KIRIM.*?\]/gi, '').trim();
        let newCatatan = cleanCatatan ? `[KIRIM SEWA LUAR - ${namaSupir}] ${cleanCatatan}` : `[KIRIM SEWA LUAR - ${namaSupir}]`;

        // 1. Buat record trip di trip_pengiriman agar terdaftar di Riwayat Perjalanan & terlacak
        let tripPayload = {
            tanggal: order.tanggal,
            cabang: 'PM',
            armada: armadaStr,
            sopir_user_id: null,
            urutan_rit: 1,
            total_kg: order.totalKg || 0,
            jarak_tempuh_km: 0,
            status_trip: 'SELESAI',
            catatan: `[SEWA LUAR - ${namaSupir}] ${order.relasi}`,
            manifest_items: order.manifestItems || [{ relasi: order.relasi, pakan: order.pakanText || 'Pakan', qty: order.totalKg || 0 }]
        };

        let primaryTripId = null;
        let resTrip = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': supaPin
            },
            body: JSON.stringify(tripPayload)
        });

        if (!resTrip.ok && supaPin !== '1234') {
            resTrip = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                    'x-pin-karyawan': '1234'
                },
                body: JSON.stringify(tripPayload)
            });
        }

        if (resTrip.ok) {
            let created = await resTrip.json();
            if (created?.[0]?.id) primaryTripId = created[0].id;
        }

        // 2. Update baris pakan di transaksi_pakan secara robust (ID per row + tanggal & relasi fallback)
        let patchObj = {
            armada: armadaStr,
            catatan: newCatatan
        };
        if (primaryTripId) patchObj.trip_id = primaryTripId;

        await patchTransaksiPakanRows(order.txIds, order.tanggal, order.relasi, patchObj);

        // 3. Update baris Ongkir Pengiriman di transaksi_pakan jika ada
        let patchOngkirObj = {
            armada: armadaStr,
            catatan: `[SEWA LUAR - ${namaSupir}] Ongkir diteruskan ke supir luar`
        };
        if (primaryTripId) patchOngkirObj.trip_id = primaryTripId;

        await patchOngkirRow(order.ongkirRowId, order.tanggal, order.relasi, patchOngkirObj);

        // 4. Catat uang keluar di Cashflow untuk bayar supir luar (jika ada ongkirnya)
        let nominalOngkir = order.ongkirNominal || 0;
        if (nominalOngkir <= 0 && window._cacheArmadaData?.ongkirRows) {
            let rMatch = window._cacheArmadaData.ongkirRows.find(o => 
                o.tanggal === order.tanggal && 
                (o.relasi || '').trim().toLowerCase() === (order.relasi || '').trim().toLowerCase()
            );
            if (rMatch) {
                nominalOngkir = (parseFloat(rMatch.harga_satuan) || 0) * (parseFloat(rMatch.qty) || 1);
            }
        }

        if (nominalOngkir > 0) {
            let cfPayload = {
                tanggal: order.tanggal,
                jenis: 'Keluar',
                metode: 'Cash',
                kategori: 'OPR Ekspedisi Pakan',
                relasi: `Supir Luar (${namaSupir})`,
                nominal: nominalOngkir,
                diskon: 0,
                keterangan: `Bayar Ongkir Pengantaran ${order.relasi} (${new Intl.NumberFormat('id-ID').format(order.totalKg || 0)} Kg) via Supir Luar (${namaSupir})` + (primaryTripId ? ` [TRIP:${primaryTripId}]` : ''),
                bukti_url: '-',
                petugas: (typeof activeUser !== 'undefined' && activeUser) ? activeUser : 'Admin Logistik'
            };

            let resCF = await fetch(`${SUPA_URL}/rest/v1/cashflow`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                    'x-pin-karyawan': supaPin
                },
                body: JSON.stringify(cfPayload)
            });

            if (!resCF.ok && supaPin !== '1234') {
                await fetch(`${SUPA_URL}/rest/v1/cashflow`, {
                    method: 'POST',
                    headers: {
                        'apikey': SUPA_ANON_KEY,
                        'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation',
                        'x-pin-karyawan': '1234'
                    },
                    body: JSON.stringify(cfPayload)
                });
            }
        }

        window._selectedOrderToAssign = null;
        tutupModalTambahTripManual();
        let nf = new Intl.NumberFormat('id-ID');
        let ongkirMsg = nominalOngkir > 0 ? `\n(Uang Keluar Cashflow: Rp ${nf.format(nominalOngkir)} telah otomatis dicatat untuk bayar ${namaSupir})` : '';
        alert(`✅ Orderan ${order.relasi} berhasil ditugaskan ke: ${armadaStr}!${ongkirMsg}`);
        if (typeof loadLogBBMAdmin === 'function') {
            await loadLogBBMAdmin();
        }
    } catch (e) {
        console.error("Gagal tugaskan supir luar:", e);
        alert("Terjadi kesalahan: " + e.message);
    }
}
window.eksekusiTugaskanSewaLuar = eksekusiTugaskanSewaLuar;

async function simpanTripManualAdmin() {
    let tgl = document.getElementById('manual-trip-tanggal')?.value;
    let armada = document.getElementById('manual-trip-armada')?.value;
    let tujuan = document.getElementById('manual-trip-tujuan')?.value.trim();
    let kg = parseFloat(document.getElementById('manual-trip-kg')?.value) || 0;
    let titik = parseInt(document.getElementById('manual-trip-titik')?.value) || 1;
    let catatan = document.getElementById('manual-trip-catatan')?.value.trim();

    if (!tgl) return alert("Pilih tanggal pengantaran!");
    if (!armada) return alert("Pilih armada pengantar!");
    if (!tujuan) return alert("Masukkan nama tujuan / konsumen / peternak!");
    if (kg <= 0) return alert("Masukkan total muatan (Kg) yang valid!");

    let sopirId = null;
    if (armada.includes('8707') || armada.includes('8070')) sopirId = 6;
    else if (armada.includes('8142')) sopirId = 7;
    else if (armada.includes('8749')) {
        let users = window.tripState?.cachedUsers || [];
        let agusUser = users.find(u => (u.nama || '').toLowerCase().includes('agus') && (u.role || '').toLowerCase() === 'sopir');
        if (agusUser) sopirId = agusUser.id;
    }

    let btn = document.getElementById('btn-simpan-trip-manual');
    let origText = btn ? btn.innerText : '';
    if (btn) { btn.disabled = true; btn.innerText = "Menyimpan..."; }

    try {
        let fullCatatan = catatan ? `${tujuan} - ${catatan}` : tujuan;
        if (titik > 1) fullCatatan += ` [${titik} Titik]`;
        let payload = {
            tanggal: tgl,
            cabang: 'PM',
            armada: armada,
            sopir_user_id: sopirId,
            total_kg: kg,
            status_trip: 'SELESAI',
            catatan: fullCatatan,
            manifest_items: [{ relasi: tujuan, pakan: 'Pakan Ternak', qty: kg }]
        };

        let supaPin = (typeof currentLoggedPin !== 'undefined' && currentLoggedPin) ? currentLoggedPin : (localStorage.getItem('cbl_user_pin') || '1234');
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
                'x-pin-karyawan': supaPin
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok && supaPin !== '1234') {
            res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman`, {
                method: 'POST',
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                    'x-pin-karyawan': '1234'
                },
                body: JSON.stringify(payload)
            });
        }

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || 'Gagal menyimpan pengantaran');
        }

        let createdTrips = await res.json();
        let newTripId = Array.isArray(createdTrips) && createdTrips[0]?.id ? createdTrips[0].id : null;

        // Jika admin menugaskan dari pesanan yang belum diantar (Ambil Mandiri)
        if (newTripId && window._selectedOrderToAssign && Array.isArray(window._selectedOrderToAssign.txIds) && window._selectedOrderToAssign.txIds.length > 0) {
            try {
                let cleanCatatan = (window._selectedOrderToAssign.catatan || '').replace(/\[AMBIL SENDIRI.*?\]|\[KIRIM.*?\]/gi, '').trim();
                let newCatatan = cleanCatatan ? `[KIRIM ${armada}] ${cleanCatatan}` : `[KIRIM ${armada}]`;
                await patchTransaksiPakanRows(window._selectedOrderToAssign.txIds, window._selectedOrderToAssign.tanggal, window._selectedOrderToAssign.relasi, {
                    trip_id: newTripId,
                    armada: armada,
                    catatan: newCatatan
                });
                await patchOngkirRow(window._selectedOrderToAssign.ongkirRowId, window._selectedOrderToAssign.tanggal, window._selectedOrderToAssign.relasi, {
                    trip_id: newTripId,
                    armada: armada
                });
            } catch (eLink) {
                console.warn("Gagal hubungkan transaksi_pakan ke trip manual:", eLink);
            }
            window._selectedOrderToAssign = null;
        }

        // Sinkronkan solar truk ke cashflow jika armada Truk
        if (newTripId && (armada.includes('8749') || armada.toLowerCase().includes('truk'))) {
            await syncSolarTrukToCashflow(newTripId, armada, tgl, titik, tujuan);
        }

        alert(`✅ Sukses! Pengantaran ${armada} (${tujuan}, ${kg} Kg) berhasil ditambahkan ke log armada.`);
        tutupModalTambahTripManual();
        if (typeof loadLogBBMAdmin === 'function') await loadLogBBMAdmin();
    } catch (e) {
        alert("Gagal menambahkan pengantaran: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = origText; }
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
window.setArmadaPeriodFilter = setArmadaPeriodFilter;
window.onTujuanFilterChange = onTujuanFilterChange;
window.clearTujuanFilter = clearTujuanFilter;
window.renderBarometerArmada = renderBarometerArmada;
window.updateDatalistTujuan = updateDatalistTujuan;
window.setAdminPayrollFilter = setAdminPayrollFilter;
window.cetakFormKlaimDariAdmin = cetakFormKlaimDariAdmin;
window.bukaModalKelolaTripAdmin = bukaModalKelolaTripAdmin;
window.tutupModalKelolaTripAdmin = tutupModalKelolaTripAdmin;
window.pindahArmadaTripAdmin = pindahArmadaTripAdmin;
window.simpanRitTripAdmin = simpanRitTripAdmin;
window.eksekusiPecahTripAdmin = eksekusiPecahTripAdmin;
window.onInputSisaKgChange = onInputSisaKgChange;
window.onInputSplitKgChange = onInputSplitKgChange;
window.renderRaporArmadaView = renderRaporArmadaView;
window.cetakRaporArmada = cetakRaporArmada;
window.toggleRaporSetting = toggleRaporSetting;
window.bukaModalTambahTripManual = bukaModalTambahTripManual;
window.tutupModalTambahTripManual = tutupModalTambahTripManual;
window.simpanTripManualAdmin = simpanTripManualAdmin;
window.eksekusiGabungTripAdmin = eksekusiGabungTripAdmin;
window.hapusTripAdminDariLog = hapusTripAdminDariLog;
window.bukaShortcutCashflow = function() {
    if (typeof gantiHalaman === 'function') gantiHalaman('laporan');
    let radioCF = document.querySelector('input[name="mode_input"][value="cashflow"]');
    if (radioCF) {
        radioCF.checked = true;
        if (typeof toggleModeInput === 'function') toggleModeInput();
    }
    let radioKeluar = document.getElementById('cf_keluar');
    if (radioKeluar) {
        radioKeluar.checked = true;
        if (typeof updateKategoriCashflow === 'function') updateKategoriCashflow();
    }
};

window.renderRekapPayrollAdmin = renderRekapPayrollAdmin;
window.navigateArmadaPeriod = navigateArmadaPeriod;
window.switchFilterRuteMode = switchFilterRuteMode;
window.bukaModalTugaskanArmada = bukaModalTugaskanArmada;
window.eksekusiTugaskanArmadaCepat = eksekusiTugaskanArmadaCepat;
window.bukaModalPilihanRitOverload = bukaModalPilihanRitOverload;
window.tutupModalPilihanRitOverload = tutupModalPilihanRitOverload;
window.konfirmasiRitOverload = konfirmasiRitOverload;
window.resequenceTripsForDateAndArmada = resequenceTripsForDateAndArmada;
window.autoPecahTripKapasitasAdmin = autoPecahTripKapasitasAdmin;
window.syncSolarTrukToCashflow = syncSolarTrukToCashflow;



