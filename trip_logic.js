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
const TARIF_INSENTIF_TOTAL_PICKUP = 15; // Rp / Kg
const TARIF_ANGKAT_PICKUP = 10; // Rp / Kg (Komponen Otot)
const TARIF_SUBSIDI_JARAK_PICKUP = 5; // Rp / Kg (Toples Jarak)
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
// 2. KALKULASI JARAK (HAVERSINE & GEOLOCATION)
// ====================================================================

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

// Hitung Estimasi Jarak Jalan Realistis (dengan faktor kelok jalan pegunungan 1.3)
function hitungEstimasiJarakRealistis(lat1, lon1, lat2, lon2) {
    let haversine = hitungHaversineKm(lat1, lon1, lat2, lon2);
    let estimasi = haversine * 1.3;
    return Math.round(estimasi * 10) / 10;
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
// 4. LOGIKA PERHITUNGAN INSENTIF (SOLUSI A: OTOT + TOPLES JARAK SIKLUS)
// ====================================================================

/**
 * Menghitung rincian upah bersih & toples jarak untuk seluruh trip periode ini.
 * Plafon total: Rp 15/kg.
 * - Komponen Otot: Rp 10 / kg (bagi rata kru angkat pick-up)
 * - Komponen Jarak: Rp 5 / kg (dikumpulkan ke toples dan dibagi proporsional km)
 * - Truk: Bersih Rp 15 / kg dibagi rata ke kru muat gudang + uang solar supir.
 */
function hitungAkumulasiInsentifPeriode(trips = [], users = []) {
    let userMap = {};
    users.forEach(u => {
        userMap[u.id] = {
            id: u.id,
            nama: u.nama,
            role: u.role,
            totalKgOtot: 0,
            totalKm: 0,
            upahOtot: 0,
            subsidiJarak: 0,
            upahMuatTruk: 0,
            uangSolarTruk: 0,
            totalBersih: 0,
            tripCount: 0
        };
    });

    // 1. Akumulasi Total Toples Jarak & Total Km Armada Pick-Up
    let totalToplesJarak = 0;
    let totalKmSemuaPickup = 0;

    trips.forEach(tr => {
        let isPickup = (tr.armada === 'D 8070 UE' || tr.armada === 'D 8142 UK');
        if (isPickup) {
            let kg = parseFloat(tr.total_kg) || 0;
            let km = parseFloat(tr.jarak_tempuh_km) || 0;
            totalToplesJarak += (kg * TARIF_SUBSIDI_JARAK_PICKUP);
            totalKmSemuaPickup += km;
        }
    });

    // 2. Distribusi Insentif per Trip
    trips.forEach(tr => {
        let isTruk = (tr.armada === 'Truk');
        let isAmbilMandiri = (tr.armada === 'Ambil Mandiri');
        let kg = parseFloat(tr.total_kg) || 0;
        let km = parseFloat(tr.jarak_tempuh_km) || 0;

        if (isTruk || isAmbilMandiri) {
            // Truk / Ambil Mandiri: Upah Bersih Rp 15/kg Kru Muat Gudang
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
                        userMap[uid].upahMuatTruk += dapat;
                        userMap[uid].totalKgOtot += Math.round(kg / nKru);
                        userMap[uid].totalBersih += dapat;
                        userMap[uid].tripCount += 1;
                    }
                });
            }
        } else {
            // Pick-Up
            let sopirId = tr.sopir_user_id;
            let k1Id = tr.kernek_1_user_id;
            let k2Id = tr.kernek_2_user_id;
            let hasK2 = !!k2Id;

            // A. Upah Otot (Rp 10/kg)
            let totalUpahOtotTrip = kg * TARIF_ANGKAT_PICKUP;
            let nKru = hasK2 ? 3 : (k1Id ? 2 : 1);
            let perKruOtot = Math.floor(totalUpahOtotTrip / nKru);

            if (sopirId && userMap[sopirId]) {
                userMap[sopirId].upahOtot += perKruOtot;
                userMap[sopirId].totalKgOtot += Math.round(kg / nKru);
                userMap[sopirId].totalKm += km;
                userMap[sopirId].totalBersih += perKruOtot;
                userMap[sopirId].tripCount += 1;
            }
            if (k1Id && userMap[k1Id]) {
                userMap[k1Id].upahOtot += perKruOtot;
                userMap[k1Id].totalKgOtot += Math.round(kg / nKru);
                userMap[k1Id].totalKm += km;
                userMap[k1Id].totalBersih += perKruOtot;
                userMap[k1Id].tripCount += 1;
            }
            if (k2Id && userMap[k2Id]) {
                let sisaOtot = totalUpahOtotTrip - (perKruOtot * 2);
                userMap[k2Id].upahOtot += sisaOtot;
                userMap[k2Id].totalKgOtot += Math.round(kg / nKru);
                userMap[k2Id].totalKm += km;
                userMap[k2Id].totalBersih += sisaOtot;
                userMap[k2Id].tripCount += 1;
            }

            // B. Porsi Toples Jarak (Proporsional Km)
            // Di Pick-Up: 60% Sopir, 40% Kernek
            if (totalKmSemuaPickup > 0 && km > 0) {
                let rupiahJarakTrip = Math.round((km / totalKmSemuaPickup) * totalToplesJarak);
                let jatahSopirJarak = Math.round(rupiahJarakTrip * (hasK2 ? 0.6 : 0.6));
                let jatahK1Jarak = Math.round(rupiahJarakTrip * (hasK2 ? 0.2 : 0.4));
                let jatahK2Jarak = hasK2 ? (rupiahJarakTrip - jatahSopirJarak - jatahK1Jarak) : 0;

                if (sopirId && userMap[sopirId]) {
                    userMap[sopirId].subsidiJarak += jatahSopirJarak;
                    userMap[sopirId].totalBersih += jatahSopirJarak;
                }
                if (k1Id && userMap[k1Id]) {
                    userMap[k1Id].subsidiJarak += jatahK1Jarak;
                    userMap[k1Id].totalBersih += jatahK1Jarak;
                }
                if (k2Id && userMap[k2Id]) {
                    userMap[k2Id].subsidiJarak += jatahK2Jarak;
                    userMap[k2Id].totalBersih += jatahK2Jarak;
                }
            }
        }
    });

    let grandTotal = Object.values(userMap).reduce((acc, u) => acc + u.totalBersih, 0);

    return {
        userMap,
        totalToplesJarak,
        totalKmSemuaPickup,
        grandTotal
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

    renderArmadaKernekPills();
    await refreshAntreanDriver();
    await loadDompetDriver();

    // Deteksi jika supir/kernek memiliki trip aktif yang sedang berjalan
    await cekTripAktifDriver();
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

    if (myRole.includes('kernek')) {
        // JIKA LOGIN SEBAGAI KERNEK (misal: Enggeng):
        // 1. Pilih Sopir Armada (Wajib 1)
        // 2. Pilih Kernek Tambahan (Opsional 1 orang lain)
        let driverCandidates = users.filter(u => (u.role || '').toLowerCase().includes('sopir'));
        let otherKruCandidates = users.filter(u => {
            let r = (u.role || '').toLowerCase();
            return (r.includes('kernek') || r.includes('lapangan') || r.includes('petugas') || r.includes('kandang')) && u.nama !== activeUser;
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
        // JIKA LOGIN SEBAGAI SOPIR (misal: Hilman):
        let kruCandidates = users.filter(u => {
            let r = (u.role || '').toLowerCase();
            return (r.includes('kernek') || r.includes('lapangan') || r.includes('petugas') || r.includes('kandang')) && u.nama !== activeUser;
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
    document.querySelectorAll('.btn-pill-armada').forEach(b => {
        let isSel = (b.dataset.armada === armadaPlat);
        b.style.background = isSel ? '#2563eb' : '#f1f5f9';
        b.style.color = isSel ? '#ffffff' : '#475569';
        b.style.borderColor = isSel ? '#1d4ed8' : '#cbd5e1';
    });
    refreshAntreanDriver();
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
}

function selectKernekChip(userId) {
    selectPartnerChip(userId, 'kernek');
}

function resetKernekSelection() {
    window.tripState.selectedKernekIds = [];
    renderArmadaKernekPills();
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

    let cardsHtml = Object.values(relasiGroups).map((grp, grpIdx) => {
        let safeKey = 'rel_' + grpIdx;
        let rData = window.tripState.cachedRelasiMap[grp.relasi] || {};
        let rLat = rData.lat ? parseFloat(rData.lat) : null;
        let rLng = rData.lng ? parseFloat(rData.lng) : null;

        // Estimasi Jarak dari posisi supir saat ini ke kandang
        let estimasiKm = (rLat && rLng) ? hitungEstimasiJarakRealistis(currentGps.lat, currentGps.lng, rLat, rLng) : 0;
        let jarakLabel = estimasiKm > 0 ? `${estimasiKm} Km` : `<span style="color:#d97706; font-size:10px;">GPS Kandang Belum Ada</span>`;
        let estimasiMenit = estimasiKm > 0 ? Math.round((estimasiKm / 25) * 60) : 15;

        let estimasiUpahOtot = Math.round((grp.totalSisaKg * TARIF_ANGKAT_PICKUP) / 2);
        let poinBeban = Math.round(((grp.totalSisaKg / 50) + estimasiKm) * 10) / 10;
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
                               oninput="hitungTotalBawaRelasi('${safeKey}')"
                               style="flex:1; padding:7px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; font-weight:800; text-align:center; color:#1e3a8a;">
                        <span style="font-size:11px; font-weight:700; color:#64748b;">Kg</span>
                        <button type="button" onclick="setBawaFullTx(${it.id}, ${it.sisa_qty}, '${safeKey}')" style="padding:6px 10px; font-size:11px; font-weight:700; background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:6px; cursor:pointer;">Semua</button>
                        <button type="button" onclick="setBawaNolTx(${it.id}, '${safeKey}')" style="padding:6px 10px; font-size:11px; font-weight:700; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer;">0</button>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:15px; margin-bottom:12px; box-shadow:0 2px 5px rgba(0,0,0,0.03);">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                    <div>
                        <h4 style="margin:0; font-size:15px; font-weight:800; color:#1e293b;">${grp.relasi}</h4>
                        <div style="font-size:11px; color:#64748b; margin-top:2px; display:inline-flex; align-items:center; gap:3px;">
                            <span class="material-symbols-outlined" style="font-size:13px; color:#ef4444;">location_on</span>
                            <span>${grp.alamat}</span>
                        </div>
                    </div>
                    <span style="background:#eff6ff; color:#1d4ed8; font-size:12px; font-weight:800; padding:3px 8px; border-radius:6px; border:1px solid #bfdbfe;">
                        Total Sisa: ${nf.format(grp.totalSisaKg)} Kg
                    </span>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#475569; margin-bottom:10px; padding:0 2px;">
                    <span style="display:inline-flex; align-items:center; gap:3px;">
                        <span class="material-symbols-outlined" style="font-size:14px; color:#64748b;">navigation</span>
                        <b>${jarakLabel}</b> <span style="color:#94a3b8;">(~${estimasiMenit} mnt)</span>
                    </span>
                    <span style="display:inline-flex; align-items:center; gap:3px;">
                        <span class="material-symbols-outlined" style="font-size:14px; color:#64748b;">scale</span>
                        <b>${poinBeban}</b> Poin
                    </span>
                    <span style="display:inline-flex; align-items:center; gap:3px; color:#15803d; font-weight:800;">
                        <span class="material-symbols-outlined" style="font-size:14px; color:#15803d;">payments</span>
                        ±Rp ${nf.format(estimasiUpahOtot)}
                    </span>
                </div>

                <!-- Daftar Input Qty per Jenis Pakan -->
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:10px; margin-bottom:12px;">
                    <div style="font-size:11px; font-weight:700; color:#475569; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                        <span>${isSingleItem ? 'Muatan yang Dibawa Rit Ini:' : 'Pilih & Tentukan Kg per Jenis Pakan:'}</span>
                        ${!isSingleItem ? `<button type="button" onclick="setBawaSemuaItemRelasi('${safeKey}')" style="background:none; border:none; color:#2563eb; font-size:11px; font-weight:700; cursor:pointer; text-decoration:underline;">Bawa Semua</button>` : ''}
                    </div>
                    ${itemInputsHtml}
                </div>

                <!-- Bagian Eksekusi Berangkat -->
                <div style="border-top:1px dashed #e2e8f0; padding-top:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <span style="font-size:12px; font-weight:700; color:#475569;">Total Muatan Pick-Up:</span>
                        <strong style="font-size:14px; font-weight:800; color:#15803d;">
                            <span id="label-total-kg-${safeKey}">${nf.format(totalInitialKg)}</span> Kg
                        </strong>
                    </div>
                    <button type="button" id="btn-antar-${safeKey}" onclick="mulaiAntarKonsumen('${safeKey}', '${escapedRelasi}')" style="width:100%; background:linear-gradient(135deg, #2563eb, #1d4ed8); color:white; border:none; padding:11px 14px; border-radius:8px; font-size:13px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; box-shadow:0 2px 6px rgba(37,99,235,0.25);">
                        <span class="material-symbols-outlined" style="font-size:18px;">local_shipping</span> Berangkatkan (<span id="btn-kg-${safeKey}">${nf.format(totalInitialKg)}</span> Kg)
                    </button>
                    <small style="color:#64748b; font-size:10px; display:block; margin-top:5px; text-align:center;">*Sisa pakan yang tidak terangkut otomatis tetap menunggu di antrean.</small>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = cardsHtml;
}

// Helper kalkulasi total muatan per relasi di layar supir
function hitungTotalBawaRelasi(safeKey) {
    let inputs = document.querySelectorAll(`.input-bawa-${safeKey}`);
    let total = 0;
    inputs.forEach(inp => {
        let v = parseFloat(inp.value) || 0;
        total += v;
    });
    let lbl = document.getElementById(`label-total-kg-${safeKey}`);
    let btnKg = document.getElementById(`btn-kg-${safeKey}`);
    let nf = new Intl.NumberFormat('id-ID');
    if (lbl) lbl.innerText = nf.format(total);
    if (btnKg) btnKg.innerText = nf.format(total);
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
        let qty = parseFloat(inp.value) || 0;
        let maxQty = parseFloat(inp.dataset.max) || 0;
        let txId = parseInt(inp.dataset.txId);
        let pakan = inp.dataset.pakan || 'Pakan';

        if (qty > maxQty) {
            return alert(`Jumlah muatan ${pakan} (${qty} Kg) melebihi sisa pesanan (${maxQty} Kg)!`);
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
    if (btn) { btn.disabled = true; btn.innerText = "Mengunci GPS..."; }

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
        
        // Beralih ke Tampilan Trip Sedang Berjalan
        tampilkanLayarTripBerjalan(activeTrip, namaRelasi, totalKg);
    } catch (e) {
        alert("Gagal memulai perjalanan: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = `Berangkatkan (${totalKg} Kg)`; }
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

    // 2. Hitung Jarak Tempuh Leg ini
    let trip = window.tripState.activeTripItem || {};
    let latStart = trip.lat_start || LAT_GUDANG_CBL;
    let lngStart = trip.lng_start || LNG_GUDANG_CBL;

    // Jarak Berangkat: dari Titik Berangkat -> Kandang Peternak
    let legBerangkatKm = hitungEstimasiJarakRealistis(latStart, lngStart, gpsEnd.lat, gpsEnd.lng);

    // Jarak Pulang: jika supir konfirmasi kembali ke Gudang PM
    let legPulangKm = 0;
    if (kembaliKeGudang) {
        // Hitung jarak kembali dari Kandang Peternak -> Gudang PM
        legPulangKm = hitungEstimasiJarakRealistis(gpsEnd.lat, gpsEnd.lng, LAT_GUDANG_CBL, LNG_GUDANG_CBL);
    }

    let totalJarakKm = Math.round((legBerangkatKm + legPulangKm) * 10) / 10;
    let poinBeban = Math.round(((qtyKg / 50) + totalJarakKm) * 10) / 10;

    let catatanTambahan = kembaliKeGudang 
        ? ` (PP ke Gudang PM, total ${totalJarakKm} Km)` 
        : ` (Lanjut estafet, leg ${totalJarakKm} Km)`;

    let payloadUpdate = {
        status_trip: 'SELESAI',
        waktu_selesai: new Date().toISOString(),
        lat_end: gpsEnd.lat,
        lng_end: gpsEnd.lng,
        jarak_tempuh_km: totalJarakKm,
        poin_beban: poinBeban,
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

        // 5. Hitung Hadiah Uang Otot Langsung untuk Efek Selebrasi Psikologis
        let hasK2 = !!trip.kernek_2_user_id;
        let upahOtotDapat = Math.round((qtyKg * TARIF_ANGKAT_PICKUP) / (hasK2 ? 3 : 2));

        tampilkanModalSelebrasi(namaRelasi, upahOtotDapat, totalJarakKm, kembaliKeGudang);

        // Reset Tampilan
        document.getElementById('driver-active-trip-box')?.classList.add('hidden');
        document.getElementById('driver-order-cards-list')?.classList.remove('hidden');
        document.getElementById('driver-pill-selectors-box')?.classList.remove('hidden');

        refreshAntreanDriver();
        loadDompetDriver();
    } catch (e) {
        alert("Gagal konfirmasi selesai: " + e.message);
    } finally {
        if (btnPm) { btnPm.disabled = false; btnPm.innerText = "1. Selesai & Kembali ke Gudang PM (PP)"; }
        if (btnLanjut) { btnLanjut.disabled = false; }
    }
}

// Pop-up Selebrasi Psikologis (+Rp Masuk ke Dompet!)
function tampilkanModalSelebrasi(namaRelasi, rupiahOtot, legKm, kembaliKeGudang = true) {
    let modal = document.getElementById('driver-celebration-modal');
    if (!modal) return;
    let nf = new Intl.NumberFormat('id-ID');

    document.getElementById('celeb-nama-peternak').innerText = namaRelasi;
    document.getElementById('celeb-nominal-uang').innerText = `+Rp ${nf.format(rupiahOtot)}`;
    
    let infoKmText = kembaliKeGudang 
        ? `+${legKm} Km (Termasuk Pulang ke PM) ditambahkan ke Tabungan Jarak` 
        : `+${legKm} Km (Leg Antar) ditambahkan ke Tabungan Jarak`;
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
// 6. DOMPET DRIVER & KLAIM INSENTIF
// ====================================================================

async function loadDompetDriver() {
    let meUser = (window.tripState.cachedUsers || []).find(u => u.nama === activeUser);
    if (!meUser) return;

    let today = new Date().toISOString().split('T')[0];
    let trips = await fetchTripsByDateRange(today, today);
    let users = window.tripState.cachedUsers || [];

    let akumulasi = hitungAkumulasiInsentifPeriode(trips, users);
    let myData = akumulasi.userMap[meUser.id] || {
        upahOtot: 0,
        subsidiJarak: 0,
        upahMuatTruk: 0,
        uangSolarTruk: 0,
        totalBersih: 0,
        totalKm: 0,
        totalKgOtot: 0
    };

    let nf = new Intl.NumberFormat('id-ID');

    let upahMuat = myData.upahOtot || 0;
    let upahNgantar = myData.subsidiJarak || 0;
    let totalUpah = upahMuat + upahNgantar;

    // Update Kartu Utama Dompet Sesuai Rincian Baru
    let elMuat = document.getElementById('dompet-upah-muat');
    if (elMuat) elMuat.innerText = `Rp ${nf.format(upahMuat)}`;

    let elNgantar = document.getElementById('dompet-estimasi-ngantar');
    if (elNgantar) elNgantar.innerText = `Rp ${nf.format(upahNgantar)}`;

    let elTotalUpah = document.getElementById('dompet-total-upah');
    if (elTotalUpah) elTotalUpah.innerText = `Rp ${nf.format(totalUpah)}`;

    // Fallback backwards-compatibility
    let elOtot = document.getElementById('dompet-upah-otot');
    if (elOtot) elOtot.innerText = `Rp ${nf.format(upahMuat)}`;

    let elTotalBersih = document.getElementById('dompet-total-bersih');
    if (elTotalBersih) elTotalBersih.innerText = `Rp ${nf.format(myData.totalBersih)}`;

    // Update Tabungan Jarak (Semi-Transparan)
    let elPoolTotal = document.getElementById('dompet-pool-toples');
    if (elPoolTotal) elPoolTotal.innerText = `Rp ${nf.format(akumulasi.totalToplesJarak)}`;

    let elKmSaya = document.getElementById('dompet-km-saya');
    if (elKmSaya) elKmSaya.innerText = `${myData.totalKm} Km dari ${akumulasi.totalKmSemuaPickup} Km Total`;

    let elEstimasiJarak = document.getElementById('dompet-estimasi-jarak');
    if (elEstimasiJarak) elEstimasiJarak.innerText = `Rp ${nf.format(myData.subsidiJarak)}`;

    // Render Riwayat Pengantaran
    let tbodyRiwayat = document.getElementById('driver-riwayat-tbody');
    if (tbodyRiwayat) {
        let myTrips = trips.filter(tr => tr.sopir_user_id === meUser.id || tr.kernek_1_user_id === meUser.id || tr.kernek_2_user_id === meUser.id || (tr.pekerja_muat_ids || []).includes(meUser.id));
        if (myTrips.length === 0) {
            tbodyRiwayat.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:#94a3b8; font-style:italic;">Belum ada pengantaran selesai hari ini.</td></tr>`;
        } else {
            tbodyRiwayat.innerHTML = myTrips.map(tr => {
                let rNama = tr.manifest_items?.[0]?.relasi || tr.catatan || 'Pengantaran';
                return `
                    <tr style="border-bottom:1px solid #f1f5f9; font-size:11px;">
                        <td style="padding:8px 6px; font-weight:700; color:#1e293b;">${rNama}</td>
                        <td style="padding:8px 6px; text-align:right;">${nf.format(tr.total_kg)} Kg</td>
                        <td style="padding:8px 6px; text-align:right;">${tr.jarak_tempuh_km} Km</td>
                        <td style="padding:8px 6px; text-align:center;">
                            <span style="background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; padding:2px 6px; border-radius:10px;">Selesai</span>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }
}

// Beralih Tab di Layar Driver (Order Kirim vs Dompet)
function pindahDriverTab(tab) {
    document.querySelectorAll('#driver-nav .nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`nav-driver-${tab}`)?.classList.add('active');

    let viewOrder = document.getElementById('driver-view-order');
    let viewDompet = document.getElementById('driver-view-dompet');

    if (tab === 'order') {
        if (viewOrder) viewOrder.classList.remove('hidden');
        if (viewDompet) viewDompet.classList.add('hidden');
        refreshAntreanDriver();
    } else {
        if (viewOrder) viewOrder.classList.add('hidden');
        if (viewDompet) viewDompet.classList.remove('hidden');
        loadDompetDriver();
    }
}

// Cetak Slip Klaim Upah Supir / Kernek
function cetakSlipKlaimDriver() {
    window.print();
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
                       oninput="hitungTotalMuatTruk()" 
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
                               oninput="hitungTotalMuatTruk()"
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

function hitungTotalMuatTruk() {
    let inputs = document.querySelectorAll('.input-truk-item');
    let total = 0;
    inputs.forEach(inp => {
        total += (parseFloat(inp.value) || 0);
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
        let qty = parseFloat(inp.value) || 0;
        let maxQty = parseFloat(inp.dataset.max) || 0;
        let txId = inp.dataset.txId ? parseInt(inp.dataset.txId) : null;
        let pakan = inp.dataset.pakan || 'Pakan';

        if (qty > maxQty) {
            return alert(`Muatan ${pakan} (${qty} Kg) melebihi sisa pesanan (${maxQty} Kg)!`);
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

        alert(`✅ Pengiriman Truk Berhasil Diberangkatkan!\nMuatan: ${inputKg.toLocaleString('id-ID')} Kg\nKru: ${kruIds.length} Orang\nSolar Sopir: Rp 100.000`);
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

    // 1. Render Barometer Keadilan 100% Horizontal Stacked Bar
    if (containerBarometer) {
        let p1Poin = 0, p2Poin = 0, p1Kg = 0, p2Kg = 0, p1Km = 0, p2Km = 0;
        trips.forEach(tr => {
            if (tr.armada === 'D 8070 UE') {
                p1Poin += (parseFloat(tr.poin_beban) || 0);
                p1Kg += (parseFloat(tr.total_kg) || 0);
                p1Km += (parseFloat(tr.jarak_tempuh_km) || 0);
            } else if (tr.armada === 'D 8142 UK') {
                p2Poin += (parseFloat(tr.poin_beban) || 0);
                p2Kg += (parseFloat(tr.total_kg) || 0);
                p2Km += (parseFloat(tr.jarak_tempuh_km) || 0);
            }
        });

        let totalPoin = p1Poin + p2Poin;
        let pctP1 = totalPoin > 0 ? Math.round((p1Poin / totalPoin) * 100) : 50;
        let pctP2 = totalPoin > 0 ? (100 - pctP1) : 50;
        let isSeimbang = (pctP1 >= 45 && pctP1 <= 55);

        containerBarometer.innerHTML = `
            <div style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:15px; margin-bottom:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:13px; font-weight:800; color:#1e293b;">⚖️ Barometer Keadilan Beban Pick-Up</span>
                    <span style="font-size:10px; font-weight:800; padding:3px 8px; border-radius:12px; background:${isSeimbang ? '#dcfce7' : '#fef3c7'}; color:${isSeimbang ? '#15803d' : '#b45309'};">
                        ${isSeimbang ? '✅ SEIMBANG (45-55%)' : '⚠️ KURANG SEIMBANG'}
                    </span>
                </div>
                <div style="height:22px; border-radius:6px; overflow:hidden; display:flex; background:#e2e8f0;">
                    <div style="width:${pctP1}%; background:#2563eb; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center;">D 8070 UE (${pctP1}%)</div>
                    <div style="width:${pctP2}%; background:#ea580c; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center;">D 8142 UK (${pctP2}%)</div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; font-size:11px; color:#475569;">
                    <div>• <b>D 8070 UE:</b> ${nf.format(p1Kg)} Kg | ${p1Km} Km | <b>${p1Poin} Poin</b></div>
                    <div>• <b>D 8142 UK:</b> ${nf.format(p2Kg)} Kg | ${p2Km} Km | <b>${p2Poin} Poin</b></div>
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

// Rekap Payroll & Tombol Tutup Periode Toples Jarak
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

    tbody.innerHTML = rows.map(u => `
        <tr style="border-bottom:1px solid #e2e8f0; font-size:11px;">
            <td style="padding:8px; font-weight:700; color:#1e293b;">${u.nama}</td>
            <td style="padding:8px; text-transform:capitalize; color:#64748b;">${u.role}</td>
            <td style="padding:8px; text-align:right;">${nf.format(u.totalKgOtot)} Kg</td>
            <td style="padding:8px; text-align:right; color:#2563eb;">Rp ${nf.format(u.upahOtot)}</td>
            <td style="padding:8px; text-align:right; color:#d97706;">Rp ${nf.format(u.subsidiJarak)}</td>
            <td style="padding:8px; text-align:right; color:#15803d;">Rp ${nf.format(u.upahMuatTruk + u.uangSolarTruk)}</td>
            <td style="padding:8px; text-align:right; font-weight:800; color:#1e3a8a; font-size:12px;">Rp ${nf.format(u.totalBersih)}</td>
        </tr>
    `).join('');

    if (tfoot) tfoot.innerText = `Rp ${nf.format(akumulasi.grandTotal)}`;
}

// Tombol Admin: Cairkan & Tutup Periode Toples Jarak
async function tutupPeriodeDanCairkanToples() {
    let konfirm = confirm("Apakah Anda yakin ingin MENUTUP PERIODE dan mencairkan toples jarak? Seluruh saldo trip yang belum dicairkan akan ditandai LUNAS dan toples kembali ke Rp 0 untuk periode berikutnya.");
    if (!konfirm) return;

    let today = new Date().toISOString().split('T')[0];
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/trip_pengiriman?tanggal=lte.${today}&status_klaim=eq.BELUM_KLAIM`, {
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

        alert("✅ Periode Berhasil Ditutup & Toples Jarak Direset! Slip gaji siap dibagikan.");
        renderRekapPayrollAdmin();
    } catch (e) {
        alert("Gagal menutup periode: " + e.message);
    }
}

function switchAdminTripTab(tab) {
    const tabs = ['antrean', 'monitor', 'payroll'];
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

// Admin Window Exports
window.initModulTripAdmin = initModulTripAdmin;
window.switchAdminTripTab = switchAdminTripTab;
window.bukaModalMuatTruk = bukaModalMuatTruk;
window.tutupModalMuatTruk = tutupModalMuatTruk;
window.hitungTotalMuatTruk = hitungTotalMuatTruk;
window.setBawaFullTrukItem = setBawaFullTrukItem;
window.setBawaNolTrukItem = setBawaNolTrukItem;
window.simpanKeberangkatanTruk = simpanKeberangkatanTruk;
window.tutupPeriodeDanCairkanToples = tutupPeriodeDanCairkanToples;
window.kunciTitikKandangPeternak = autoLockTitikKandang;


