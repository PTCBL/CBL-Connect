/**
 * ==============================================================================
 * DOMPET REMBES LOGIC - SISTEM PAKAN PT CITA BENGGALA LESTARI (CBL CONNECT)
 * Modul Manajemen Kas Kecil (Imprest Fund) & Dana Talangan Pribadi Real-Time
 * Desain Minimalis, Clean, Tanpa Emoticon, Menggunakan Material Symbols Outlined
 * ==============================================================================
 */

// State Global Dompet
let dompetPlafon = parseInt(localStorage.getItem('cbl_dompet_plafon')) || 2500000;
let dompetRekeningTrf = localStorage.getItem('cbl_dompet_rekening') || 'BCA a.n. Wildan';
let dompetDataAktif = [];
let dompetDataSelesai = [];
let dompetTabMode = 'aktif'; // 'aktif' | 'selesai'
let dompetFilterKat = 'ALL';
let dompetCheckedIds = new Set();
let dompetLastSaldoKas = null;
let dompetEditId = null;

// Form Toggle State
let dompetFormJenis = 'Keluar';
let dompetFormMetode = 'Cash';

// File Upload Cache untuk Form Dompet
let dompetFileBase64 = "";
let dompetFileMime = "";

/**
 * Inisialisasi Modul Dompet Reimburse
 */
async function initDompetRembes() {
    if (typeof currentRole !== 'undefined' && currentRole && currentRole !== 'admin') {
        alert("Akses Ditolak: Hanya Admin Pusat (Wildan) yang dapat membuka Dompet Reimburse.");
        return;
    }
    renderDompetShell();
    await muatDataDompet();
}

/**
 * Render Wadah Utama Dompet Reimburse
 */
function renderDompetShell() {
    let container = document.getElementById('view-dompet-rembes');
    if (!container) return;

    container.innerHTML = `
        <!-- HEADER FINANSIAL (CARD FINTECH CLEAN) -->
        <div id="dompet-card-saldo" style="background: linear-gradient(135deg, #1a5c40 0%, #2d7a57 100%); color: white; border-radius: 16px; padding: 20px; box-shadow: 0 10px 25px rgba(26, 92, 64, 0.22); position: relative; margin-bottom: 15px; overflow: hidden;">
            <span class="material-symbols-outlined" style="position: absolute; right: -15px; bottom: -25px; font-size: 130px; opacity: 0.08; color: #ffffff; pointer-events: none; user-select: none;">account_balance_wallet</span>
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="material-symbols-outlined" style="font-size: 20px; color: #a7f3d0;">account_balance_wallet</span>
                    <span style="font-size: 13px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #d1fae5;">Dompet Kas & Reimburse</span>
                </div>
                <button type="button" onclick="bukaModalAturPlafon()" title="Atur Plafon Kas" style="background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); color: #fff; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 4px; backdrop-filter: blur(4px);">
                    <span class="material-symbols-outlined" style="font-size: 14px;">tune</span> Plafon
                </button>
            </div>

            <div style="margin-top: 10px;">
                <div style="font-size: 11px; color: #a7f3d0; font-weight: 500;">Sisa Uang Kas Fisik di Tangan:</div>
                <div id="dompet-saldo-kas-angka" style="font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin: 3px 0 6px 0; color: #ffffff;">
                    Rp 0
                </div>
                <div style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #d1fae5;">
                    <span>Plafon: <b id="dompet-plafon-label">Rp ${dompetPlafon.toLocaleString('id-ID')}</b></span>
                    <span>•</span>
                    <span id="dompet-status-kas-badge" style="background: rgba(255,255,255,0.2); padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 10px;">Normal</span>
                </div>
            </div>

            <div style="margin-top: 15px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.25); display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div style="background: rgba(0,0,0,0.15); padding: 8px 10px; border-radius: 8px;">
                    <div style="font-size: 10px; color: #93c5fd; font-weight: 700; display: flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 13px;">account_balance</span> Talangan Pribadi (Trf):
                    </div>
                    <div id="dompet-talangan-trf-angka" style="font-size: 14px; font-weight: 800; color: #ffffff; margin-top: 2px;">Rp 0</div>
                </div>
                <div style="background: rgba(0,0,0,0.15); padding: 8px 10px; border-radius: 8px;">
                    <div style="font-size: 10px; color: #fde047; font-weight: 700; display: flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 13px;">receipt_long</span> Total Siap Klaim:
                    </div>
                    <div id="dompet-total-klaim-angka" style="font-size: 14px; font-weight: 800; color: #fde047; margin-top: 2px;">Rp 0</div>
                </div>
            </div>
        </div>

        <!-- ACTION BAR: 4 TOMBOL UTAMA -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 15px;">
            <button type="button" onclick="bukaFormInputDompet()" style="background: #1a5c40; color: white; border: none; padding: 12px 10px; border-radius: 10px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 10px rgba(26,92,64,0.18);">
                <span class="material-symbols-outlined" style="font-size: 18px;">add_circle</span> Catat Pengeluaran
            </button>
            <button type="button" onclick="bukaModalTerimaRembes()" style="background: #0284c7; color: white; border: none; padding: 12px 10px; border-radius: 10px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 10px rgba(2,132,199,0.18);">
                <span class="material-symbols-outlined" style="font-size: 18px;">check_circle</span> Terima Rembes
            </button>
            <button type="button" onclick="bukaModalShareWA()" style="background: #16a34a; color: white; border: none; padding: 10px; border-radius: 10px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 10px rgba(22,163,74,0.18);">
                <span class="material-symbols-outlined" style="font-size: 18px;">send</span> Share Rincian WA
            </button>
            <button type="button" onclick="bukaModalCetakPDF()" style="background: #ea580c; color: white; border: none; padding: 10px; border-radius: 10px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 10px rgba(234,88,12,0.18);">
                <span class="material-symbols-outlined" style="font-size: 18px;">print</span> Cetak PDF A4
            </button>
        </div>

        <!-- FORM INPUT EXPANDABLE (MODERN SEGMENTED CONTROLS, CLEAN NO EMOJIS) -->
        <div id="dompet-form-container" class="hidden" style="background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 12px; padding: 16px; margin-bottom: 20px; box-shadow: 0 8px 25px rgba(0,0,0,0.06);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                <span id="dompet-form-title" style="font-weight: 800; font-size: 14px; color: #1a5c40; display: flex; align-items: center; gap: 6px;">
                    <span class="material-symbols-outlined" style="font-size: 18px;">post_add</span> Catat Pengeluaran Baru
                </span>
                <button type="button" onclick="tutupFormInputDompet()" style="background: none; border: none; color: #64748b; font-size: 18px; cursor: pointer; padding: 2px 6px;">✕</button>
            </div>

            <!-- TOGGLE 1: JENIS (KELUAR vs MASUK) -->
            <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 5px;">Jenis Transaksi:</label>
            <div style="background: #f1f5f9; padding: 4px; border-radius: 10px; display: flex; gap: 4px; margin-bottom: 12px; border: 1px solid #e2e8f0;">
                <button type="button" id="btn-toggle-jenis-keluar" onclick="setDompetJenis('Keluar')"
                    style="flex: 1; padding: 10px 8px; border-radius: 8px; border: none; font-size: 12px; font-weight: 800; cursor: pointer; background: #dc2626; color: #ffffff; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 2px 6px rgba(220,38,38,0.22); transition: all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size: 16px;">trending_down</span> Uang Keluar
                </button>
                <button type="button" id="btn-toggle-jenis-masuk" onclick="setDompetJenis('Masuk')"
                    style="flex: 1; padding: 10px 8px; border-radius: 8px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; background: transparent; color: #64748b; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size: 16px;">trending_up</span> Uang Masuk
                </button>
            </div>

            <!-- TOGGLE 2: METODE (CASH vs TRANSFER) -->
            <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 5px;">Metode Pembayaran:</label>
            <div style="background: #f1f5f9; padding: 4px; border-radius: 10px; display: flex; gap: 4px; margin-bottom: 14px; border: 1px solid #e2e8f0;">
                <button type="button" id="btn-toggle-metode-cash" onclick="setDompetMetode('Cash')"
                    style="flex: 1; padding: 10px 8px; border-radius: 8px; border: none; font-size: 12px; font-weight: 800; cursor: pointer; background: #1a5c40; color: #ffffff; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 2px 6px rgba(26,92,64,0.22); transition: all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size: 16px;">payments</span> Cash Fisik
                </button>
                <button type="button" id="btn-toggle-metode-trf" onclick="setDompetMetode('Transfer')"
                    style="flex: 1; padding: 10px 8px; border-radius: 8px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; background: transparent; color: #64748b; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size: 16px;">account_balance</span> Transfer Pribadi
                </button>
            </div>

            <!-- TANGGAL & WAKTU -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;">
                <div>
                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Tanggal:</label>
                    <input type="date" id="dompet-input-tanggal" style="width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; box-sizing: border-box; background: white;">
                </div>
                <div>
                    <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Jam / Waktu:</label>
                    <input type="time" id="dompet-input-waktu" style="width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; box-sizing: border-box; background: white;">
                </div>
            </div>

            <!-- PRESET CHIP KATEGORI CEPAT (CLEAN MATERIAL ICONS) -->
            <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Pilih Cepat Kategori:</label>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;">
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('BBM / Solar', 'BBM')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">local_gas_station</span> Solar
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('Bongkar Muat', 'BM')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">forklift</span> Bongkar Muat
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('Konsumsi & Dapur', 'UM')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">restaurant</span> Uang Makan
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('Servis Rutin / Ganti Oli', 'Servis')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">build</span> Servis/Ban
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('BBM / Solar', 'Bensin')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">two_wheeler</span> Bensin Motor
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('Kasbon', 'Kasbon')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">request_quote</span> Kasbon
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('Listrik, Air & Internet', 'Wifi')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">wifi</span> Internet/Wifi
                </button>
                <button type="button" class="dompet-chip" onclick="pilihKategoriDompet('Lainnya', '')">
                    <span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">more_horiz</span> Lainnya
                </button>
            </div>

            <!-- DROPDOWN KATEGORI & RELASI -->
            <div style="margin-bottom: 10px;">
                <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Kategori Resmi:</label>
                <select id="dompet-select-kategori" onchange="onDompetKategoriSelectChange()" style="width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; background: white;"></select>
            </div>

            <!-- PILIHAN 3 ARMADA CERDAS (JIKA KATEGORI ARMADA) -->
            <div id="dompet-box-armada" class="hidden" style="margin-bottom: 12px; background: #f8fafc; padding: 10px; border-radius: 8px; border: 1px solid #cbd5e1;">
                <label style="font-size: 11px; font-weight: 700; color: #1e293b; display: block; margin-bottom: 6px;">Pilih Armada:</label>
                <div style="display: flex; gap: 6px;">
                    <button type="button" onclick="pilihArmadaDompet('D 8707 UE (Hilman)')" style="flex: 1; padding: 8px 4px; border: 1.5px solid #cbd5e1; border-radius: 8px; background: #fff; font-size: 11px; font-weight: 700; cursor: pointer;">
                        <span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle; color: #2563eb;">local_shipping</span> D 8707 UE
                        <div style="font-size: 9px; color: #2563eb; margin-top: 2px;">Hilman</div>
                    </button>
                    <button type="button" onclick="pilihArmadaDompet('D 8142 UK (Adi)')" style="flex: 1; padding: 8px 4px; border: 1.5px solid #cbd5e1; border-radius: 8px; background: #fff; font-size: 11px; font-weight: 700; cursor: pointer;">
                        <span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle; color: #ea580c;">local_shipping</span> D 8142 UK
                        <div style="font-size: 9px; color: #ea580c; margin-top: 2px;">Adi</div>
                    </button>
                    <button type="button" onclick="pilihArmadaDompet('D 8749 UA (Agus)')" style="flex: 1; padding: 8px 4px; border: 1.5px solid #cbd5e1; border-radius: 8px; background: #fff; font-size: 11px; font-weight: 700; cursor: pointer;">
                        <span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle; color: #0f766e;">local_shipping</span> D 8749 UA
                        <div style="font-size: 9px; color: #0f766e; margin-top: 2px;">Truk Agus</div>
                    </button>
                </div>
            </div>

            <!-- RELASI / TUJUAN -->
            <div style="margin-bottom: 10px;">
                <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Relasi / Pihak Terkait:</label>
                <input type="text" id="dompet-input-relasi" placeholder="Cth: SPBU Padalarang / Bengkel / Salman / Iwan" style="width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; box-sizing: border-box; background: white;">
            </div>

            <!-- NOMINAL BAYAR (NUMPAD BESAR) -->
            <div style="margin-bottom: 10px;">
                <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Nominal (Rp):</label>
                <input type="text" inputmode="numeric" id="dompet-input-nominal" oninput="formatRupiah(this)" placeholder="0" style="width: 100%; padding: 12px 10px; border: 2px solid #1a5c40; border-radius: 8px; font-size: 18px; font-weight: 800; color: #1a5c40; box-sizing: border-box; background: white;">
            </div>

            <!-- KETERANGAN RINCI -->
            <div style="margin-bottom: 12px;">
                <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Keterangan Rinci:</label>
                <textarea id="dompet-input-keterangan" rows="2" placeholder="Catatan transaksi..." style="width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; box-sizing: border-box; background: white; font-family: inherit;"></textarea>
            </div>

            <!-- TOGGLE CERDAS: MASUK KE TABEL CASHFLOW SUPABASE -->
            <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 10px; margin-bottom: 12px;">
                <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; margin: 0;">
                    <input type="checkbox" id="dompet-check-cashflow" checked style="width: 18px; height: 18px; margin-top: 2px;">
                    <div>
                        <div style="font-size: 12px; font-weight: 700; color: #3730a3;">Sinkron ke Cashflow Operasional Pakan</div>
                        <div style="font-size: 10px; color: #6366f1; margin-top: 2px;">Otomatis masuk ke laporan Cashflow & Jurnal Supabase tanpa input 2 kali. (Uncheck jika bukan operasional pakan, misal kasbon pribadi supir/wifi kantor).</div>
                    </div>
                </label>
            </div>

            <!-- UPLOAD FOTO STRUK / BUKTI (OPSIONAL) -->
            <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px; margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="font-size: 11px; font-weight: 700; color: #475569; display: flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 15px;">receipt</span> Foto Struk / Nota (Opsional)
                    </span>
                    <label style="display: flex; align-items: center; gap: 5px; font-size: 10px; color: #d97706; font-weight: 700; cursor: pointer;">
                        <input type="checkbox" id="dompet-check-struk-menyusul" style="margin: 0;"> Struk Menyusul
                    </label>
                </div>
                <input type="file" id="dompet-input-file" accept="image/*" onchange="onDompetFileChange(this)" style="font-size: 11px; width: 100%; box-sizing: border-box; margin-bottom: 6px;">
                
                <div id="dompet-preview-wrap" style="display: none; text-align: center; margin-top: 8px;">
                    <img id="dompet-preview-img" style="max-height: 120px; border-radius: 6px; border: 1px solid #cbd5e1; margin-bottom: 4px;">
                    <div>
                        <button type="button" onclick="hapusPreviewDompet()" style="background: #ef4444; color: white; border: none; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; cursor: pointer;">Hapus Foto</button>
                    </div>
                </div>
            </div>

            <!-- TOMBOL SIMPAN -->
            <div style="display: flex; gap: 8px;">
                <button type="button" onclick="tutupFormInputDompet()" style="flex: 1; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; font-weight: 700; font-size: 12px; color: #64748b; cursor: pointer;">Batal</button>
                <button type="button" id="btn-simpan-dompet" onclick="simpanTransaksiDompet()" style="flex: 2; padding: 10px; border: none; border-radius: 8px; background: #1a5c40; font-weight: 800; font-size: 13px; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                    <span class="material-symbols-outlined" style="font-size: 18px;">save</span> Simpan Pengeluaran
                </button>
            </div>
        </div>

        <!-- FILTER & SELEKSI DAFTAR -->
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; margin-bottom: 12px;">
            <!-- TAB AKTIF vs RIWAYAT SELESAI -->
            <div style="display: flex; gap: 6px; margin-bottom: 10px;">
                <button type="button" id="tab-dompet-aktif" onclick="switchDompetTab('aktif')" style="flex: 1; padding: 8px 6px; border-radius: 8px; border: none; font-size: 12px; font-weight: 800; cursor: pointer; background: #1a5c40; color: white; display: flex; align-items: center; justify-content: center; gap: 5px; transition: all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size: 15px;">schedule</span> Belum Cair (<span id="count-dompet-aktif">0</span>)
                </button>
                <button type="button" id="tab-dompet-selesai" onclick="switchDompetTab('selesai')" style="flex: 1; padding: 8px 6px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 12px; font-weight: 700; cursor: pointer; background: #f8fafc; color: #64748b; display: flex; align-items: center; justify-content: center; gap: 5px; transition: all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size: 15px;">done_all</span> Riwayat Selesai (<span id="count-dompet-selesai">0</span>)
                </button>
            </div>

            <!-- FILTER KATEGORI & CHECKLIST SEMUA -->
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <label style="display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: #1e293b; cursor: pointer;">
                        <input type="checkbox" id="dompet-check-all" onchange="toggleSelectAllDompet(this)" style="width: 16px; height: 16px;">
                        <span>Pilih Semua</span>
                    </label>
                    <span id="dompet-counter-terpilih" style="font-size: 10px; background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 10px; font-weight: 700;">0 Terpilih</span>
                </div>
                <div>
                    <select id="dompet-filter-kategori-sel" onchange="onDompetFilterKategoriChange(this.value)" style="padding: 5px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 11px; background: white; font-weight: 600; color: #334155;">
                        <option value="ALL">Semua Kategori</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- DAFTAR TRANSAKSI (CONTAINER LIST) -->
        <div id="dompet-list-container">
            <div style="text-align: center; padding: 30px 10px; color: #94a3b8; font-size: 12px;">
                <div class="loader" style="margin: 0 auto 10px auto;"></div>
                Memuat catatan dompet rembes...
            </div>
        </div>
    `;

    injectDompetCSS();
    isiPilihanKategoriDompet();
    resetFormInputDompet();
}

/**
 * Sisipkan CSS Khusus Dompet jika belum ada
 */
function injectDompetCSS() {
    if (document.getElementById('dompet-custom-css')) return;
    let style = document.createElement('style');
    style.id = 'dompet-custom-css';
    style.innerHTML = `
        .dompet-chip {
            background: #ffffff;
            border: 1px solid #cbd5e1;
            color: #334155;
            padding: 5px 9px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            transition: all 0.15s ease;
        }
        .dompet-chip:active, .dompet-chip.active {
            background: #1a5c40;
            color: #ffffff;
            border-color: #1a5c40;
        }
        .dompet-chip .material-symbols-outlined {
            font-size: 14px;
        }
        .dompet-item-card {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 10px 12px;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.02);
            transition: transform 0.1s ease;
        }
        .dompet-item-card.checked {
            border-color: #8AA624;
            background: #fbfdf5;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Mengisi Dropdown Kategori di Form & Filter
 */
function isiPilihanKategoriDompet() {
    let formSel = document.getElementById('dompet-select-kategori');
    let filterSel = document.getElementById('dompet-filter-kategori-sel');
    if (!formSel || !filterSel) return;

    let kategoriList = (typeof KATG_KELUAR !== 'undefined') ? KATG_KELUAR : [
        "BBM / Solar", "Tambal Ban / Isi Angin", "Servis Rutin / Ganti Oli",
        "Perbaikan & Sparepart Kendaraan", "Cuci Armada", "Perawatan Kendaraan",
        "OPR Ekspedisi Pakan", "Bongkar Muat", "Upah Giling", "OPR Kandang", "Listrik, Air & Internet",
        "Perlengkapan & Kebersihan", "Konsumsi & Dapur", "Bayar Hutang Pakan", "Tarik Deposit", "Kasbon", "Lainnya"
    ];

    formSel.innerHTML = "";
    kategoriList.forEach(k => {
        let opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        formSel.appendChild(opt);
    });

    filterSel.innerHTML = `<option value="ALL">Semua Kategori</option>`;
    kategoriList.forEach(k => {
        let opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        filterSel.appendChild(opt);
    });
}

/**
 * Tarik Data Transaksi dari Supabase (dengan Fallback LocalStorage)
 */
async function muatDataDompet(forceReload = false) {
    let listContainer = document.getElementById('dompet-list-container');
    if (listContainer && (!dompetDataAktif.length && !dompetDataSelesai.length)) {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 30px 10px; color: #94a3b8; font-size: 12px;">
                <div class="loader" style="margin: 0 auto 10px auto;"></div>
                Memuat catatan dompet rembes...
            </div>
        `;
    }

    try {
        let sUrl = typeof SUPA_URL !== 'undefined' ? SUPA_URL : 'https://hwpbkdmaeqovhxttkrmj.supabase.co';
        let sKey = typeof SUPA_ANON_KEY !== 'undefined' ? SUPA_ANON_KEY : '';

        let res = await fetch(`${sUrl}/rest/v1/dompet_rembes?order=tanggal.desc,id.desc`, {
            headers: {
                'apikey': sKey,
                'Authorization': `Bearer ${sKey}`
            }
        });

        if (!res.ok) throw new Error("Gagal mengambil data dari Supabase");

        let rawData = await res.json();
        if (Array.isArray(rawData)) {
            dompetDataAktif = rawData.filter(d => d.status_reimburse !== 'SELESAI');
            dompetDataSelesai = rawData.filter(d => d.status_reimburse === 'SELESAI');

            localStorage.setItem('cbl_dompet_cache_aktif', JSON.stringify(dompetDataAktif));
            localStorage.setItem('cbl_dompet_cache_selesai', JSON.stringify(dompetDataSelesai));
        }
    } catch (err) {
        console.warn("Offline / Gagal ambil data Supabase, memuat dari cache lokal:", err);
        dompetDataAktif = JSON.parse(localStorage.getItem('cbl_dompet_cache_aktif') || '[]');
        dompetDataSelesai = JSON.parse(localStorage.getItem('cbl_dompet_cache_selesai') || '[]');
    }

    // Default: Semua item aktif dicentang untuk diajukan
    if (dompetCheckedIds.size === 0) {
        dompetDataAktif.forEach(item => dompetCheckedIds.add(item.id));
    }

    hitungDanRenderSaldo();
    renderDaftarTransaksi();
}

/**
 * Hitung Saldo Real-Time & Jalankan Animasi Count-Up
 */
function hitungDanRenderSaldo() {
    let totalKeluarCash = 0;
    let totalMasukCash = 0;
    let totalKeluarTrf = 0;
    let totalMasukTrf = 0;

    dompetDataAktif.forEach(item => {
        let nom = parseInt(item.nominal) || 0;
        if (item.metode === 'Cash') {
            if (item.jenis === 'Keluar') totalKeluarCash += nom;
            else if (item.jenis === 'Masuk') totalMasukCash += nom;
        } else if (item.metode === 'Transfer') {
            if (item.jenis === 'Keluar') totalKeluarTrf += nom;
            else if (item.jenis === 'Masuk') totalMasukTrf += nom;
        }
    });

    // Sisa Kas Fisik di Tangan
    let sisaKasFisik = dompetPlafon - totalKeluarCash + totalMasukCash;

    // Talangan Transfer (Uang pribadi yang dipakai)
    let talanganTrf = totalKeluarTrf - totalMasukTrf;

    // Total yang Siap Diklaim
    let klaimCash = Math.max(0, dompetPlafon - sisaKasFisik);
    let klaimTrf = Math.max(0, talanganTrf);
    let totalSiapKlaim = klaimCash + klaimTrf;

    // Render Badge Status Kas
    let badgeEl = document.getElementById('dompet-status-kas-badge');
    let saldoAngkaEl = document.getElementById('dompet-saldo-kas-angka');

    if (badgeEl && saldoAngkaEl) {
        if (sisaKasFisik < 0) {
            badgeEl.style.background = '#dc2626';
            badgeEl.style.color = '#fff';
            badgeEl.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px; vertical-align:middle;">warning</span> Nombok Cash Rp ${Math.abs(sisaKasFisik).toLocaleString('id-ID')}`;
            saldoAngkaEl.style.color = '#fca5a5';
        } else if (sisaKasFisik < 500000) {
            badgeEl.style.background = '#f59e0b';
            badgeEl.style.color = '#fff';
            badgeEl.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px; vertical-align:middle;">warning</span> Menipis`;
            saldoAngkaEl.style.color = '#fde047';
        } else {
            badgeEl.style.background = 'rgba(255,255,255,0.2)';
            badgeEl.style.color = '#fff';
            badgeEl.innerText = 'Aman';
            saldoAngkaEl.style.color = '#ffffff';
        }
    }

    // Jalankan Animasi Count-Up untuk Sisa Kas Fisik
    let startVal = (dompetLastSaldoKas !== null) ? dompetLastSaldoKas : 0;
    animasiCountUpDompet('dompet-saldo-kas-angka', startVal, sisaKasFisik, 650);
    dompetLastSaldoKas = sisaKasFisik;

    // Update Angka Talangan & Total Klaim
    let talanganEl = document.getElementById('dompet-talangan-trf-angka');
    let totalKlaimEl = document.getElementById('dompet-total-klaim-angka');
    let plafonLabelEl = document.getElementById('dompet-plafon-label');

    if (talanganEl) talanganEl.innerText = `Rp ${talanganTrf.toLocaleString('id-ID')}`;
    if (totalKlaimEl) totalKlaimEl.innerText = `Rp ${totalSiapKlaim.toLocaleString('id-ID')}`;
    if (plafonLabelEl) plafonLabelEl.innerText = `Rp ${dompetPlafon.toLocaleString('id-ID')}`;

    let countAktifEl = document.getElementById('count-dompet-aktif');
    let countSelesaiEl = document.getElementById('count-dompet-selesai');
    if (countAktifEl) countAktifEl.innerText = dompetDataAktif.length;
    if (countSelesaiEl) countSelesaiEl.innerText = dompetDataSelesai.length;
}

/**
 * Efek Animasi Count-Up / Rolling Odometer untuk Angka Saldo
 */
function animasiCountUpDompet(elId, startVal, endVal, duration = 650) {
    let el = document.getElementById(elId);
    if (!el) return;

    let startTime = null;
    let isNegative = endVal < 0;
    let absEnd = Math.abs(endVal);
    let absStart = Math.abs(startVal || 0);

    function step(timestamp) {
        if (!startTime) startTime = timestamp;
        let progress = Math.min((timestamp - startTime) / duration, 1);
        let ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
        let current = Math.floor(absStart + (absEnd - absStart) * ease);

        el.innerText = (isNegative ? '- Rp ' : 'Rp ') + current.toLocaleString('id-ID');

        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            el.innerText = (isNegative ? '- Rp ' : 'Rp ') + absEnd.toLocaleString('id-ID');
        }
    }

    requestAnimationFrame(step);
}

/**
 * Render Daftar Item Transaksi (Tab Aktif vs Selesai)
 */
function renderDaftarTransaksi() {
    let listContainer = document.getElementById('dompet-list-container');
    if (!listContainer) return;

    let dataSource = (dompetTabMode === 'aktif') ? dompetDataAktif : dompetDataSelesai;

    if (dompetFilterKat !== 'ALL') {
        dataSource = dataSource.filter(item => item.kategori === dompetFilterKat);
    }

    if (dataSource.length === 0) {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 40px 10px; background: white; border-radius: 12px; border: 1px dashed #cbd5e1; color: #94a3b8;">
                <span class="material-symbols-outlined" style="font-size: 36px; color: #cbd5e1;">inbox</span>
                <div style="font-size: 13px; font-weight: 700; margin-top: 5px; color: #64748b;">Belum Ada Transaksi</div>
                <div style="font-size: 11px; margin-top: 2px;">${dompetTabMode === 'aktif' ? 'Semua pengeluaran sudah direimburse atau belum ada data.' : 'Belum ada riwayat transaksi yang selesai.'}</div>
            </div>
        `;
        updateCounterTerpilih();
        return;
    }

    let html = '';
    dataSource.forEach(item => {
        let isChecked = dompetCheckedIds.has(item.id);
        let nom = parseInt(item.nominal) || 0;
        let isMasuk = (item.jenis === 'Masuk');
        let isCash = (item.metode === 'Cash');

        let iconName = 'receipt_long';
        let kat = item.kategori || '';
        if (kat.includes('BBM') || kat.includes('Solar') || kat.includes('Bensin')) iconName = 'local_gas_station';
        else if (kat.includes('Bongkar Muat')) iconName = 'forklift';
        else if (kat.includes('Konsumsi') || kat.includes('UM')) iconName = 'restaurant';
        else if (kat.includes('Servis') || kat.includes('Ban') || kat.includes('Kendaraan')) iconName = 'build';
        else if (kat.includes('Kasbon')) iconName = 'request_quote';
        else if (kat.includes('Internet') || kat.includes('Listrik')) iconName = 'wifi';
        else if (isMasuk) iconName = 'account_balance';

        let strukBadge = '';
        if (item.bukti_url && item.bukti_url !== '-' && item.bukti_url !== 'Gagal_Upload') {
            strukBadge = `<a href="${item.bukti_url}" target="_blank" style="text-decoration:none; display:inline-flex; align-items:center; gap:3px; background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:700;">
                <span class="material-symbols-outlined" style="font-size:11px;">image</span> Struk
            </a>`;
        } else if (item.struk_status === 'menyusul') {
            strukBadge = `<button type="button" onclick="bukaUploadStrukSusulan(${item.id})" style="background:#fff7ed; color:#c2410c; border:1px solid #fed7aa; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:2px;">
                <span class="material-symbols-outlined" style="font-size:11px;">upload</span> Upload Struk
            </button>`;
        }

        let cashflowBadge = item.masuk_cashflow ? `
            <span style="display:inline-flex; align-items:center; gap:2px; background:#eef2ff; color:#4338ca; border:1px solid #c7d2fe; padding:1px 5px; border-radius:10px; font-size:9px; font-weight:700;">
                <span class="material-symbols-outlined" style="font-size:10px;">sync</span> CF
            </span>
        ` : '';

        let tglStr = item.tanggal || '';
        let jamStr = item.waktu ? item.waktu.slice(0, 5) : '';

        html += `
            <div class="dompet-item-card ${isChecked ? 'checked' : ''}" id="card-item-${item.id}">
                ${dompetTabMode === 'aktif' ? `
                    <div style="display:flex; align-items:center;">
                        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleCheckItemDompet(${item.id}, this.checked)" style="width:18px; height:18px; cursor:pointer;">
                    </div>
                ` : ''}

                <div style="width:36px; height:36px; border-radius:8px; background:${isMasuk ? '#ecfdf5' : isCash ? '#f1f5f9' : '#eff6ff'}; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                    <span class="material-symbols-outlined" style="font-size:20px; color:${isMasuk ? '#10b981' : isCash ? '#1a5c40' : '#2563eb'};">${iconName}</span>
                </div>

                <div style="flex:1; min-width:0;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div style="font-size:12px; font-weight:800; color:#1e293b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            ${item.kategori || 'Pengeluaran'}
                        </div>
                        <div style="font-size:13px; font-weight:800; color:${isMasuk ? '#10b981' : '#b91c1c'}; flex-shrink:0; margin-left:6px;">
                            ${isMasuk ? '+ Rp ' : '- Rp '}${nom.toLocaleString('id-ID')}
                        </div>
                    </div>

                    <div style="font-size:11px; color:#475569; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${item.relasi ? `<b>${item.relasi}</b> • ` : ''}${item.keterangan || '-'}
                    </div>

                    <div style="display:flex; align-items:center; gap:6px; margin-top:4px; flex-wrap:wrap;">
                        <span style="font-size:10px; color:#94a3b8;">${tglStr}${jamStr ? ' ' + jamStr : ''}</span>
                        <span style="font-size:9px; font-weight:800; padding:1px 5px; border-radius:4px; background:${isCash ? '#e8f0d8' : '#dbeafe'}; color:${isCash ? '#1a5c40' : '#1e40af'};">
                            ${item.metode.toUpperCase()}
                        </span>
                        ${cashflowBadge}
                        ${strukBadge}
                    </div>
                </div>

                ${dompetTabMode === 'aktif' ? `
                    <div style="display:flex; flex-direction:column; gap:4px; margin-left:4px;">
                        <button type="button" onclick="bukaEditDompet(${item.id})" title="Edit Transaksi" style="background:none; border:none; color:#64748b; cursor:pointer; padding:2px;">
                            <span class="material-symbols-outlined" style="font-size:16px;">edit</span>
                        </button>
                        <button type="button" onclick="konfirmasiHapusDompet(${item.id})" title="Hapus Transaksi" style="background:none; border:none; color:#ef4444; cursor:pointer; padding:2px;">
                            <span class="material-symbols-outlined" style="font-size:16px;">delete</span>
                        </button>
                    </div>
                ` : `
                    <div style="font-size:10px; color:#10b981; font-weight:700; text-align:right;">
                        <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle;">task_alt</span> Lunas
                    </div>
                `}
            </div>
        `;
    });

    listContainer.innerHTML = html;
    updateCounterTerpilih();
}

/**
 * Toggle Checkbox Per Item
 */
function toggleCheckItemDompet(id, isChecked) {
    if (isChecked) dompetCheckedIds.add(id);
    else dompetCheckedIds.delete(id);

    let card = document.getElementById(`card-item-${id}`);
    if (card) {
        if (isChecked) card.classList.add('checked');
        else card.classList.remove('checked');
    }
    updateCounterTerpilih();
}

/**
 * Toggle Pilih Semua
 */
function toggleSelectAllDompet(masterCheckbox) {
    let checked = masterCheckbox.checked;
    dompetCheckedIds.clear();
    if (checked) {
        dompetDataAktif.forEach(item => dompetCheckedIds.add(item.id));
    }
    renderDaftarTransaksi();
}

/**
 * Update Counter Item Terpilih & Nominal Terpilih
 */
function updateCounterTerpilih() {
    let el = document.getElementById('dompet-counter-terpilih');
    let masterCheck = document.getElementById('dompet-check-all');
    if (!el) return;

    let count = dompetCheckedIds.size;
    let totalNom = 0;
    dompetDataAktif.forEach(item => {
        if (dompetCheckedIds.has(item.id)) {
            totalNom += parseInt(item.nominal) || 0;
        }
    });

    el.innerText = `${count} Terpilih (Rp ${totalNom.toLocaleString('id-ID')})`;
    if (masterCheck) {
        masterCheck.checked = (dompetDataAktif.length > 0 && count === dompetDataAktif.length);
    }
}

/**
 * Switch Tab: Aktif vs Riwayat Selesai
 */
function switchDompetTab(tab) {
    dompetTabMode = tab;
    let btnAktif = document.getElementById('tab-dompet-aktif');
    let btnSelesai = document.getElementById('tab-dompet-selesai');

    if (tab === 'aktif') {
        btnAktif.style.background = '#1a5c40';
        btnAktif.style.color = '#fff';
        btnSelesai.style.background = '#f8fafc';
        btnSelesai.style.color = '#64748b';
    } else {
        btnSelesai.style.background = '#1a5c40';
        btnSelesai.style.color = '#fff';
        btnAktif.style.background = '#f8fafc';
        btnAktif.style.color = '#64748b';
    }
    renderDaftarTransaksi();
}

/**
 * Filter Kategori Berubah
 */
function onDompetFilterKategoriChange(val) {
    dompetFilterKat = val;
    renderDaftarTransaksi();
}

/**
 * Segmented Control Handlers
 */
function setDompetJenis(jenis) {
    dompetFormJenis = jenis;
    let btnKeluar = document.getElementById('btn-toggle-jenis-keluar');
    let btnMasuk = document.getElementById('btn-toggle-jenis-masuk');
    let checkCF = document.getElementById('dompet-check-cashflow');

    if (!btnKeluar || !btnMasuk) return;

    if (jenis === 'Keluar') {
        btnKeluar.style.background = '#dc2626';
        btnKeluar.style.color = '#ffffff';
        btnKeluar.style.boxShadow = '0 2px 6px rgba(220,38,38,0.22)';
        btnKeluar.style.fontWeight = '800';

        btnMasuk.style.background = 'transparent';
        btnMasuk.style.color = '#64748b';
        btnMasuk.style.boxShadow = 'none';
        btnMasuk.style.fontWeight = '700';

        if (checkCF) checkCF.checked = true;
    } else {
        btnMasuk.style.background = '#10b981';
        btnMasuk.style.color = '#ffffff';
        btnMasuk.style.boxShadow = '0 2px 6px rgba(16,185,129,0.22)';
        btnMasuk.style.fontWeight = '800';

        btnKeluar.style.background = 'transparent';
        btnKeluar.style.color = '#64748b';
        btnKeluar.style.boxShadow = 'none';
        btnKeluar.style.fontWeight = '700';

        if (checkCF) checkCF.checked = false;
    }
}

function setDompetMetode(metode) {
    dompetFormMetode = metode;
    let btnCash = document.getElementById('btn-toggle-metode-cash');
    let btnTrf = document.getElementById('btn-toggle-metode-trf');

    if (!btnCash || !btnTrf) return;

    if (metode === 'Cash') {
        btnCash.style.background = '#1a5c40';
        btnCash.style.color = '#ffffff';
        btnCash.style.boxShadow = '0 2px 6px rgba(26,92,64,0.22)';
        btnCash.style.fontWeight = '800';

        btnTrf.style.background = 'transparent';
        btnTrf.style.color = '#64748b';
        btnTrf.style.boxShadow = 'none';
        btnTrf.style.fontWeight = '700';
    } else {
        btnTrf.style.background = '#2563eb';
        btnTrf.style.color = '#ffffff';
        btnTrf.style.boxShadow = '0 2px 6px rgba(37,99,235,0.22)';
        btnTrf.style.fontWeight = '800';

        btnCash.style.background = 'transparent';
        btnCash.style.color = '#64748b';
        btnCash.style.boxShadow = 'none';
        btnCash.style.fontWeight = '700';
    }
}

/**
 * Helper Form: Buka & Tutup Form Input
 */
function bukaFormInputDompet() {
    dompetEditId = null;
    resetFormInputDompet();
    document.getElementById('dompet-form-title').innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">post_add</span> Catat Pengeluaran Baru`;
    document.getElementById('btn-simpan-dompet').innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">save</span> Simpan Pengeluaran`;
    document.getElementById('dompet-form-container').classList.remove('hidden');
    document.getElementById('dompet-form-container').scrollIntoView({ behavior: 'smooth' });
}

function tutupFormInputDompet() {
    document.getElementById('dompet-form-container').classList.add('hidden');
    dompetEditId = null;
    resetFormInputDompet();
}

function resetFormInputDompet() {
    let now = new Date();
    let tglStr = now.toISOString().split('T')[0];
    let jamStr = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);

    let tglEl = document.getElementById('dompet-input-tanggal');
    let waktuEl = document.getElementById('dompet-input-waktu');
    if (tglEl) tglEl.value = tglStr;
    if (waktuEl) waktuEl.value = jamStr;

    setDompetJenis('Keluar');
    setDompetMetode('Cash');

    let nomEl = document.getElementById('dompet-input-nominal');
    if (nomEl) nomEl.value = "";

    let relasiEl = document.getElementById('dompet-input-relasi');
    if (relasiEl) relasiEl.value = "";

    let ketEl = document.getElementById('dompet-input-keterangan');
    if (ketEl) ketEl.value = "";

    let checkCF = document.getElementById('dompet-check-cashflow');
    if (checkCF) checkCF.checked = true;

    let checkStruk = document.getElementById('dompet-check-struk-menyusul');
    if (checkStruk) checkStruk.checked = false;

    hapusPreviewDompet();
    onDompetKategoriSelectChange();
}

/**
 * Memilih Chip Kategori Cepat
 */
function pilihKategoriDompet(kat, prefix) {
    let sel = document.getElementById('dompet-select-kategori');
    if (sel) {
        sel.value = kat;
        onDompetKategoriSelectChange();
    }
    let ketEl = document.getElementById('dompet-input-keterangan');
    if (ketEl && prefix) {
        if (!ketEl.value.startsWith(`[${prefix}]`)) {
            ketEl.value = `[${prefix}] ${ketEl.value.replace(/^\[.*?\]\s*/, '')}`;
        }
    }
}

/**
 * Kategori Dropdown Berubah (Cek apakah kategori Armada)
 */
function onDompetKategoriSelectChange() {
    let sel = document.getElementById('dompet-select-kategori');
    let boxArmada = document.getElementById('dompet-box-armada');
    if (!sel || !boxArmada) return;

    let kat = sel.value;
    let isArmada = (kat.includes('BBM') || kat.includes('Solar') || kat.includes('Servis') || kat.includes('Perawatan') || kat.includes('Ban'));

    if (isArmada) boxArmada.classList.remove('hidden');
    else boxArmada.classList.add('hidden');
}

function pilihArmadaDompet(armadaStr) {
    let relasiEl = document.getElementById('dompet-input-relasi');
    if (relasiEl) relasiEl.value = armadaStr;
}

/**
 * Handle File Foto Struk
 */
function onDompetFileChange(input) {
    let file = input.files && input.files[0];
    if (!file) return;

    let reader = new FileReader();
    reader.onload = function(e) {
        let dataUrl = e.target.result;
        let parts = dataUrl.split(',');
        dompetFileMime = parts[0].match(/:(.*?);/)[1];
        dompetFileBase64 = parts[1];

        let prevWrap = document.getElementById('dompet-preview-wrap');
        let prevImg = document.getElementById('dompet-preview-img');
        if (prevWrap && prevImg) {
            prevImg.src = dataUrl;
            prevWrap.style.display = 'block';
        }
    };
    reader.readAsDataURL(file);
}

function hapusPreviewDompet() {
    dompetFileBase64 = "";
    dompetFileMime = "";
    let fileInput = document.getElementById('dompet-input-file');
    if (fileInput) fileInput.value = "";
    let prevWrap = document.getElementById('dompet-preview-wrap');
    if (prevWrap) prevWrap.style.display = 'none';
}

/**
 * SIMPAN TRANSAKSI (CREATE / UPDATE)
 */
async function simpanTransaksiDompet() {
    let jenis = dompetFormJenis;
    let metode = dompetFormMetode;
    let tanggal = document.getElementById('dompet-input-tanggal')?.value || new Date().toISOString().split('T')[0];
    let waktu = document.getElementById('dompet-input-waktu')?.value || '12:00';
    let kategori = document.getElementById('dompet-select-kategori')?.value || 'Lainnya';
    let relasi = document.getElementById('dompet-input-relasi')?.value?.trim() || '';
    let nominalRaw = document.getElementById('dompet-input-nominal')?.value || '0';
    let nominal = parseInt(nominalRaw.replace(/\D/g, '')) || 0;
    let keterangan = document.getElementById('dompet-input-keterangan')?.value?.trim() || '';
    let masukCF = document.getElementById('dompet-check-cashflow')?.checked || false;
    let strukMenyusul = document.getElementById('dompet-check-struk-menyusul')?.checked || false;

    if (nominal <= 0) {
        return alert("Harap masukkan nominal transaksi yang valid!");
    }

    let btn = document.getElementById('btn-simpan-dompet');
    let oriHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<div class="loader" style="width:14px; height:14px; display:inline-block; border-width:2px; vertical-align:middle;"></div> Menyimpan...`;

    try {
        let sUrl = typeof SUPA_URL !== 'undefined' ? SUPA_URL : 'https://hwpbkdmaeqovhxttkrmj.supabase.co';
        let sKey = typeof SUPA_ANON_KEY !== 'undefined' ? SUPA_ANON_KEY : '';
        let petName = typeof activeUser !== 'undefined' && activeUser ? activeUser : 'Wildan';

        let existingItem = dompetEditId ? dompetDataAktif.find(d => d.id === dompetEditId) : null;
        let buktiUrl = existingItem ? (existingItem.bukti_url || "-") : "-";
        let strukStatus = existingItem ? (existingItem.struk_status || "tidak_ada") : (strukMenyusul ? 'menyusul' : 'tidak_ada');
        if (strukMenyusul) strukStatus = 'menyusul';

        if (dompetFileBase64 && typeof uploadGambarKeSupabase === 'function') {
            btn.innerHTML = `Mengunggah foto struk...`;
            let rawFileName = `rembes_${kategori.replace(/[^a-zA-Z0-9]/g, '_')}_${tanggal}_${Date.now()}.jpg`;
            buktiUrl = await uploadGambarKeSupabase(dompetFileBase64, dompetFileMime, 'cashflow', rawFileName);
            strukStatus = 'ada';
        }

        let cashflowId = existingItem ? existingItem.cashflow_id : null;

        if (masukCF) {
            btn.innerHTML = `Sinkronisasi ke Cashflow...`;
            let payloadCF = {
                tanggal: tanggal,
                jenis: jenis,
                metode: metode,
                kategori: kategori,
                relasi: relasi || (kategori.includes('BBM') ? 'SPBU' : 'Operasional'),
                nominal: nominal,
                diskon: 0,
                keterangan: keterangan || `[Dompet Rembes] ${kategori}`,
                bukti_url: (buktiUrl !== '-') ? buktiUrl : '-',
                petugas: petName
            };

            if (cashflowId) {
                // Update baris cashflow yang sudah ada (tidak bikin duplikat)
                await fetch(`${sUrl}/rest/v1/cashflow?id=eq.${cashflowId}`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': sKey,
                        'Authorization': `Bearer ${sKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payloadCF)
                });
            } else {
                // Insert baru jika sebelumnya belum ada
                let resCF = await fetch(`${sUrl}/rest/v1/cashflow`, {
                    method: 'POST',
                    headers: {
                        'apikey': sKey,
                        'Authorization': `Bearer ${sKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation'
                    },
                    body: JSON.stringify(payloadCF)
                });

                if (resCF.ok) {
                    let cfJson = await resCF.json();
                    if (Array.isArray(cfJson) && cfJson.length > 0) {
                        cashflowId = cfJson[0].id;
                    }
                }
            }
        } else if (cashflowId) {
            // User mematikan centang cashflow pada transaksi yang sebelumnya tersinkron -> bersihkan dari cashflow
            await fetch(`${sUrl}/rest/v1/cashflow?id=eq.${cashflowId}`, {
                method: 'DELETE',
                headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}` }
            }).catch(() => {});
            cashflowId = null;
        }

        let payloadDompet = {
            tanggal: tanggal,
            waktu: waktu,
            jenis: jenis,
            metode: metode,
            kategori: kategori,
            relasi: relasi,
            nominal: nominal,
            keterangan: keterangan,
            bukti_url: buktiUrl,
            struk_status: strukStatus,
            masuk_cashflow: masukCF,
            cashflow_id: cashflowId,
            status_reimburse: 'BELUM',
            petugas: petName
        };

        if (dompetEditId) {
            let resUpdate = await fetch(`${sUrl}/rest/v1/dompet_rembes?id=eq.${dompetEditId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': sKey,
                    'Authorization': `Bearer ${sKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payloadDompet)
            });
            if (!resUpdate.ok) throw new Error("Gagal mengupdate transaksi di server");
        } else {
            let resInsert = await fetch(`${sUrl}/rest/v1/dompet_rembes`, {
                method: 'POST',
                headers: {
                    'apikey': sKey,
                    'Authorization': `Bearer ${sKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(payloadDompet)
            });
            if (!resInsert.ok) throw new Error("Gagal menyimpan transaksi ke dompet server");
        }

        tutupFormInputDompet();
        await muatDataDompet(true);

    } catch (err) {
        alert("Gagal menyimpan transaksi: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = oriHtml;
    }
}

/**
 * Buka Form Edit Transaksi
 */
function bukaEditDompet(id) {
    let item = dompetDataAktif.find(d => d.id === id);
    if (!item) return;

    bukaFormInputDompet();
    dompetEditId = id;

    document.getElementById('dompet-form-title').innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">edit</span> Edit Transaksi Kas`;
    document.getElementById('btn-simpan-dompet').innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">save</span> Simpan Perubahan`;

    setDompetJenis(item.jenis);
    setDompetMetode(item.metode);

    document.getElementById('dompet-input-tanggal').value = item.tanggal || '';
    document.getElementById('dompet-input-waktu').value = item.waktu ? item.waktu.slice(0, 5) : '';
    document.getElementById('dompet-select-kategori').value = item.kategori || 'Lainnya';
    document.getElementById('dompet-input-relasi').value = item.relasi || '';
    document.getElementById('dompet-input-nominal').value = (parseInt(item.nominal) || 0).toLocaleString('id-ID');
    document.getElementById('dompet-input-keterangan').value = item.keterangan || '';
    document.getElementById('dompet-check-cashflow').checked = !!item.masuk_cashflow;
    document.getElementById('dompet-check-struk-menyusul').checked = (item.struk_status === 'menyusul');

    onDompetKategoriSelectChange();
}

/**
 * Konfirmasi & Hapus Transaksi Dompet
 */
async function konfirmasiHapusDompet(id) {
    let item = dompetDataAktif.find(d => d.id === id);
    if (!item) return;

    let yakin = confirm(`Yakin ingin menghapus catatan pengeluaran ${item.kategori} senilai Rp ${(parseInt(item.nominal) || 0).toLocaleString('id-ID')}?`);
    if (!yakin) return;

    try {
        let sUrl = typeof SUPA_URL !== 'undefined' ? SUPA_URL : 'https://hwpbkdmaeqovhxttkrmj.supabase.co';
        let sKey = typeof SUPA_ANON_KEY !== 'undefined' ? SUPA_ANON_KEY : '';

        await fetch(`${sUrl}/rest/v1/dompet_rembes?id=eq.${id}`, {
            method: 'DELETE',
            headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}` }
        });

        if (item.cashflow_id) {
            await fetch(`${sUrl}/rest/v1/cashflow?id=eq.${item.cashflow_id}`, {
                method: 'DELETE',
                headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}` }
            }).catch(() => {});
        }

        dompetCheckedIds.delete(id);
        await muatDataDompet(true);
    } catch (err) {
        alert("Gagal menghapus transaksi: " + err.message);
    }
}

/**
 * FITUR UPLOAD STRUK SUSULAN (UNTUK BBM / NOTA GANTUNG)
 */
function bukaUploadStrukSusulan(id) {
    let item = dompetDataAktif.find(d => d.id === id);
    if (!item) return;

    let input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    input.onchange = async function() {
        let file = input.files && input.files[0];
        if (!file) return;

        let reader = new FileReader();
        reader.onload = async function(e) {
            let dataUrl = e.target.result;
            let parts = dataUrl.split(',');
            let mime = parts[0].match(/:(.*?);/)[1];
            let base64 = parts[1];

            try {
                let sUrl = typeof SUPA_URL !== 'undefined' ? SUPA_URL : 'https://hwpbkdmaeqovhxttkrmj.supabase.co';
                let sKey = typeof SUPA_ANON_KEY !== 'undefined' ? SUPA_ANON_KEY : '';
                let rawFileName = `rembes_struk_${item.kategori.replace(/[^a-zA-Z0-9]/g, '_')}_${item.tanggal}_${Date.now()}.jpg`;

                let uploadedUrl = await uploadGambarKeSupabase(base64, mime, 'cashflow', rawFileName);

                await fetch(`${sUrl}/rest/v1/dompet_rembes?id=eq.${id}`, {
                    method: 'PATCH',
                    headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bukti_url: uploadedUrl, struk_status: 'ada' })
                });

                if (item.cashflow_id) {
                    await fetch(`${sUrl}/rest/v1/cashflow?id=eq.${item.cashflow_id}`, {
                        method: 'PATCH',
                        headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ bukti_url: uploadedUrl })
                    }).catch(() => {});
                }

                alert("Struk berhasil diunggah dan otomatis tersinkron ke Cashflow!");
                await muatDataDompet(true);

            } catch (err) {
                alert("Gagal mengunggah foto struk: " + err.message);
            }
        };
        reader.readAsDataURL(file);
    };

    input.click();
}

/**
 * MODAL ATUR PLAFON DINAMIS
 */
function bukaModalAturPlafon() {
    let modal = document.getElementById('modal-atur-plafon-dompet');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-atur-plafon-dompet';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px;';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div style="background:white; border-radius:12px; max-width:400px; width:100%; padding:20px; box-sizing:border-box; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <span style="font-weight:800; font-size:15px; color:#1a5c40; display:flex; align-items:center; gap:5px;">
                    <span class="material-symbols-outlined" style="font-size:18px;">tune</span> Atur Plafon Kas Fisik
                </span>
                <button type="button" onclick="document.getElementById('modal-atur-plafon-dompet').style.display='none'" style="background:none; border:none; font-size:18px; color:#64748b; cursor:pointer;">✕</button>
            </div>

            <div style="font-size:12px; color:#64748b; margin-bottom:12px;">
                Tentukan batas modal kas fisik (uang tunai kantor) yang ditanggung jawabkan kepada Mas. Default: Rp 2.500.000.
            </div>

            <label style="font-size:11px; font-weight:700; color:#334155; display:block; margin-bottom:4px;">Nominal Plafon (Rp):</label>
            <input type="text" id="input-setting-plafon" oninput="formatRupiah(this)" value="${dompetPlafon.toLocaleString('id-ID')}" style="width:100%; padding:10px; border:2px solid #1a5c40; border-radius:8px; font-size:16px; font-weight:800; box-sizing:border-box; margin-bottom:15px;">

            <label style="font-size:11px; font-weight:700; color:#334155; display:block; margin-bottom:4px;">Rekening Penggantian Transfer (Untuk Teks WA):</label>
            <input type="text" id="input-setting-rekening" value="${dompetRekeningTrf}" placeholder="Cth: BCA 1234567890 a.n. Wildan" style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; box-sizing:border-box; margin-bottom:15px;">

            <div style="display:flex; gap:8px;">
                <button type="button" onclick="document.getElementById('modal-atur-plafon-dompet').style.display='none'" style="flex:1; padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; font-weight:700; font-size:12px; color:#64748b; cursor:pointer;">Batal</button>
                <button type="button" onclick="simpanPengaturanPlafon()" style="flex:1; padding:10px; border:none; border-radius:8px; background:#1a5c40; font-weight:800; font-size:12px; color:#fff; cursor:pointer;">Simpan</button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

function simpanPengaturanPlafon() {
    let valRaw = document.getElementById('input-setting-plafon')?.value || '2500000';
    let val = parseInt(valRaw.replace(/\D/g, '')) || 2500000;
    let rek = document.getElementById('input-setting-rekening')?.value?.trim() || 'BCA a.n. Wildan';

    dompetPlafon = val;
    dompetRekeningTrf = rek;
    localStorage.setItem('cbl_dompet_plafon', val);
    localStorage.setItem('cbl_dompet_rekening', rek);

    document.getElementById('modal-atur-plafon-dompet').style.display = 'none';
    hitungDanRenderSaldo();
    alert("Pengaturan plafon kas dan rekening berhasil disimpan.");
}

/**
 * MODAL TERIMA REMBURSE (PENCAIRAN DANA KANTOR)
 */
function bukaModalTerimaRembes() {
    let itemsToProcess = dompetDataAktif.filter(item => dompetCheckedIds.has(item.id));
    if (itemsToProcess.length === 0) {
        itemsToProcess = dompetDataAktif;
    }

    if (itemsToProcess.length === 0) {
        return alert("Tidak ada transaksi aktif yang siap dicairkan.");
    }

    let totalCashTagihan = 0;
    let totalTrfTagihan = 0;
    itemsToProcess.forEach(item => {
        let n = parseInt(item.nominal) || 0;
        if (item.jenis === 'Keluar') {
            if (item.metode === 'Cash') totalCashTagihan += n;
            else if (item.metode === 'Transfer') totalTrfTagihan += n;
        }
    });

    let modal = document.getElementById('modal-terima-rembes');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-terima-rembes';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px;';
        document.body.appendChild(modal);
    }

    let tglSekarang = new Date().toISOString().split('T')[0];

    modal.innerHTML = `
        <div style="background:white; border-radius:12px; max-width:440px; width:100%; padding:20px; box-sizing:border-box; box-shadow:0 10px 25px rgba(0,0,0,0.2); max-height:90vh; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="font-weight:800; font-size:15px; color:#0284c7; display:flex; align-items:center; gap:5px;">
                    <span class="material-symbols-outlined">check_circle</span> Konfirmasi Terima Reimburse
                </span>
                <button type="button" onclick="document.getElementById('modal-terima-rembes').style.display='none'" style="background:none; border:none; font-size:18px; color:#64748b; cursor:pointer;">✕</button>
            </div>

            <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px; padding:10px; margin-bottom:15px; font-size:12px; color:#0369a1;">
                <div>Item Terpilih yang Dicairkan: <b>${itemsToProcess.length} Transaksi</b></div>
                <div style="margin-top:2px;">Total Tagihan Sistem: <b>Rp ${(totalCashTagihan + totalTrfTagihan).toLocaleString('id-ID')}</b></div>
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-size:11px; font-weight:700; color:#334155; display:block; margin-bottom:4px;">
                    Uang Cash Diterima dari Kasir Kantor (Rp):
                </label>
                <input type="text" id="rembes-cair-cash" oninput="formatRupiah(this)" value="${totalCashTagihan.toLocaleString('id-ID')}" style="width:100%; padding:10px; border:2px solid #1a5c40; border-radius:8px; font-size:16px; font-weight:800; color:#1a5c40; box-sizing:border-box;">
                <span style="font-size:10px; color:#64748b;">(Otomatis mengisi tagihan, tapi bisa diedit jika dibulatkan oleh kantor)</span>
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-size:11px; font-weight:700; color:#334155; display:block; margin-bottom:4px;">
                    Uang Transfer Penggantian Pribadi Diterima (Rp):
                </label>
                <input type="text" id="rembes-cair-trf" oninput="formatRupiah(this)" value="${totalTrfTagihan.toLocaleString('id-ID')}" style="width:100%; padding:10px; border:2px solid #0284c7; border-radius:8px; font-size:16px; font-weight:800; color:#0284c7; box-sizing:border-box;">
                <span style="font-size:10px; color:#64748b;">(Uang penggantian yang ditransfer ke rekening Mas)</span>
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-size:11px; font-weight:700; color:#334155; display:block; margin-bottom:4px;">Tanggal Pencairan:</label>
                <input type="date" id="rembes-cair-tanggal" value="${tglSekarang}" style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; box-sizing:border-box;">
            </div>

            <div style="margin-bottom:15px;">
                <label style="font-size:11px; font-weight:700; color:#334155; display:block; margin-bottom:4px;">Catatan (Opsional):</label>
                <input type="text" id="rembes-cair-catatan" placeholder="Cth: Dibulatkan kantor / Pencairan kloter 1" style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; box-sizing:border-box;">
            </div>

            <div style="display:flex; gap:8px;">
                <button type="button" onclick="document.getElementById('modal-terima-rembes').style.display='none'" style="flex:1; padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; font-weight:700; font-size:12px; color:#64748b; cursor:pointer;">Batal</button>
                <button type="button" id="btn-proses-cair-rembes" onclick="prosesTerimaRembes()" style="flex:2; padding:10px; border:none; border-radius:8px; background:#0284c7; font-weight:800; font-size:13px; color:#fff; cursor:pointer;">
                    Simpan & Cairkan
                </button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

/**
 * Eksekusi Pencairan Reimburse
 */
async function prosesTerimaRembes() {
    let cashRaw = document.getElementById('rembes-cair-cash')?.value || '0';
    let trfRaw = document.getElementById('rembes-cair-trf')?.value || '0';
    let nominalCashCair = parseInt(cashRaw.replace(/\D/g, '')) || 0;
    let nominalTrfCair = parseInt(trfRaw.replace(/\D/g, '')) || 0;
    let tglCair = document.getElementById('rembes-cair-tanggal')?.value || new Date().toISOString().split('T')[0];
    let catatan = document.getElementById('rembes-cair-catatan')?.value?.trim() || '';

    let itemsToProcess = dompetDataAktif.filter(item => dompetCheckedIds.has(item.id));
    if (itemsToProcess.length === 0) itemsToProcess = dompetDataAktif;
    if (itemsToProcess.length === 0) return alert("Tidak ada transaksi untuk dicairkan.");

    let btn = document.getElementById('btn-proses-cair-rembes');
    btn.disabled = true;
    btn.innerText = "Memproses Pencairan...";

    try {
        let sUrl = typeof SUPA_URL !== 'undefined' ? SUPA_URL : 'https://hwpbkdmaeqovhxttkrmj.supabase.co';
        let sKey = typeof SUPA_ANON_KEY !== 'undefined' ? SUPA_ANON_KEY : '';
        let petName = typeof activeUser !== 'undefined' && activeUser ? activeUser : 'Wildan';
        let batchId = `RMB-${tglCair.replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;

        // 1. Update Semua Item Terpilih menjadi SELESAI
        let targetIds = itemsToProcess.map(it => it.id);
        for (let chunkId of targetIds) {
            await fetch(`${sUrl}/rest/v1/dompet_rembes?id=eq.${chunkId}`, {
                method: 'PATCH',
                headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status_reimburse: 'SELESAI',
                    batch_reimburse_id: batchId,
                    tanggal_cair: new Date().toISOString()
                })
            });
        }

        // 2. Insert 1 Baris Mutasi Masuk Uang Reimburse Cash (Jika ada nilai cash diterima)
        if (nominalCashCair > 0) {
            await fetch(`${sUrl}/rest/v1/dompet_rembes`, {
                method: 'POST',
                headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tanggal: tglCair,
                    waktu: new Date().toTimeString().slice(0, 5),
                    jenis: 'Masuk',
                    metode: 'Cash',
                    kategori: 'Plafon / Reimburse',
                    relasi: 'Kantor PT CBL',
                    nominal: nominalCashCair,
                    keterangan: `[Reimburse Cair] Top-Up Kas Fisik (${itemsToProcess.length} Transaksi)${catatan ? ' - ' + catatan : ''}`,
                    bukti_url: '-',
                    struk_status: 'tidak_ada',
                    masuk_cashflow: false,
                    status_reimburse: 'SELESAI',
                    batch_reimburse_id: batchId,
                    tanggal_cair: new Date().toISOString(),
                    petugas: petName
                })
            });
        }

        document.getElementById('modal-terima-rembes').style.display = 'none';
        dompetCheckedIds.clear();
        alert(`Reimburse berhasil dicairkan.\n• Batch ID: ${batchId}\n• Cash: Rp ${nominalCashCair.toLocaleString('id-ID')}\n• Trf: Rp ${nominalTrfCair.toLocaleString('id-ID')}`);
        await muatDataDompet(true);

    } catch (err) {
        alert("Gagal memproses pencairan: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Simpan & Cairkan";
    }
}

/**
 * MODAL & FITUR SHARE RINGKASAN KE WHATSAPP
 */
function bukaModalShareWA() {
    let modal = document.getElementById('modal-share-wa-dompet');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-share-wa-dompet';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px;';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div style="background:white; border-radius:12px; max-width:400px; width:100%; padding:20px; box-sizing:border-box; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="font-weight:800; font-size:15px; color:#16a34a; display:flex; align-items:center; gap:5px;">
                    <span class="material-symbols-outlined">send</span> Share Rincian Reimburse WA
                </span>
                <button type="button" onclick="document.getElementById('modal-share-wa-dompet').style.display='none'" style="background:none; border:none; font-size:18px; color:#64748b; cursor:pointer;">✕</button>
            </div>

            <div style="font-size:12px; color:#475569; margin-bottom:12px;">
                Pilih metode pembayaran yang ingin dimasukkan ke dalam teks WhatsApp:
            </div>

            <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:15px;">
                <label style="display:flex; align-items:center; gap:8px; padding:10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; background:#f8fafc;">
                    <input type="checkbox" id="wa-filter-cash" checked style="width:18px; height:18px;">
                    <span>Uang CASH (Kas Fisik)</span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; padding:10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; background:#f8fafc;">
                    <input type="checkbox" id="wa-filter-trf" checked style="width:18px; height:18px;">
                    <span>Uang TRANSFER (Talangan Pribadi)</span>
                </label>
            </div>

            <div style="display:flex; gap:8px;">
                <button type="button" onclick="document.getElementById('modal-share-wa-dompet').style.display='none'" style="flex:1; padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; font-weight:700; font-size:12px; color:#64748b; cursor:pointer;">Batal</button>
                <button type="button" onclick="eksekusiShareWA()" style="flex:2; padding:10px; border:none; border-radius:8px; background:#16a34a; font-weight:800; font-size:13px; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                    <span class="material-symbols-outlined" style="font-size:18px;">content_copy</span> Copy & Buka WA
                </button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

function eksekusiShareWA() {
    let incCash = document.getElementById('wa-filter-cash')?.checked || false;
    let incTrf = document.getElementById('wa-filter-trf')?.checked || false;

    if (!incCash && !incTrf) {
        return alert("Harap centang minimal salah satu metode (Cash atau Transfer)!");
    }

    let items = dompetDataAktif.filter(item => dompetCheckedIds.has(item.id));
    if (items.length === 0) items = dompetDataAktif;

    items = items.filter(item => {
        if (item.metode === 'Cash' && incCash) return true;
        if (item.metode === 'Transfer' && incTrf) return true;
        return false;
    });

    if (items.length === 0) {
        return alert("Tidak ada data pengeluaran yang cocok dengan filter yang dipilih.");
    }

    let now = new Date();
    let tglFormat = ("0" + now.getDate()).slice(-2) + "/" + ("0" + (now.getMonth() + 1)).slice(-2) + "/" + now.getFullYear();
    let jamFormat = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
    let petName = typeof activeUser !== 'undefined' && activeUser ? activeUser : 'Wildan';

    let totalCash = 0;
    let totalTrf = 0;

    let rincianTeks = items.map((it, idx) => {
        let n = parseInt(it.nominal) || 0;
        if (it.metode === 'Cash') totalCash += n;
        else totalTrf += n;

        let iconMetode = (it.metode === 'Cash') ? 'Cash' : 'Transfer';
        let tglItem = it.tanggal ? it.tanggal.split('-').reverse().slice(0, 2).join('/') : '';
        return `${idx + 1}. [${it.kategori}] ${it.relasi ? it.relasi + ' - ' : ''}${it.keterangan || '-'}\n   ${iconMetode}: Rp ${n.toLocaleString('id-ID')} (${tglItem})`;
    }).join('\n');

    let totalSemua = totalCash + totalTrf;

    let pesanWA = `*PENGAJUAN REIMBURSEMENT KAS OPERASIONAL*\n` +
        `*PT CITA BENGGALA LESTARI*\n` +
        `══════════════════════════════\n` +
        `Tanggal Pengajuan : ${tglFormat}, ${jamFormat} WIB\n` +
        `Pemegang Kas     : ${petName}\n` +
        `No. Referensi     : RMB-${now.toISOString().split('T')[0].replace(/-/g, '')}-${jamFormat.replace(':', '')}\n` +
        `══════════════════════════════\n\n` +
        `*RINGKASAN DANA:*\n` +
        (incCash ? `• Plafon Kas Fisik  : Rp ${dompetPlafon.toLocaleString('id-ID')}\n` : '') +
        (incCash ? `* KLAIM CASH        : Rp ${totalCash.toLocaleString('id-ID')}\n` : '') +
        (incTrf ? `* KLAIM TRANSFER    : Rp ${totalTrf.toLocaleString('id-ID')}\n` : '') +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*TOTAL KLAIM        : Rp ${totalSemua.toLocaleString('id-ID')}*\n` +
        `══════════════════════════════\n\n` +
        `*RINCIAN PENGELUARAN (${items.length} Item):*\n` +
        `${rincianTeks}\n\n` +
        (incTrf ? `══════════════════════════════\n*Rekening Penggantian Transfer:*\n${dompetRekeningTrf}\n` : '') +
        `\n_Mohon periksa dan proses pencairannya. Terima kasih._`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pesanWA).then(() => {
            alert("Teks rincian berhasil disalin ke Clipboard! Membuka WhatsApp...");
            window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(pesanWA)}`, '_blank');
        }).catch(() => {
            window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(pesanWA)}`, '_blank');
        });
    } else {
        window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(pesanWA)}`, '_blank');
    }

    document.getElementById('modal-share-wa-dompet').style.display = 'none';
}

/**
 * MODAL & FITUR CETAK PDF A4
 */
function bukaModalCetakPDF() {
    let modal = document.getElementById('modal-cetak-pdf-dompet');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-cetak-pdf-dompet';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px;';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div style="background:white; border-radius:12px; max-width:400px; width:100%; padding:20px; box-sizing:border-box; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="font-weight:800; font-size:15px; color:#ea580c; display:flex; align-items:center; gap:5px;">
                    <span class="material-symbols-outlined">print</span> Cetak Rekap Dokumen A4
                </span>
                <button type="button" onclick="document.getElementById('modal-cetak-pdf-dompet').style.display='none'" style="background:none; border:none; font-size:18px; color:#64748b; cursor:pointer;">✕</button>
            </div>

            <div style="font-size:12px; color:#475569; margin-bottom:12px;">
                Pilih metode pembayaran yang dicetak pada lembar rekap:
            </div>

            <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:15px;">
                <label style="display:flex; align-items:center; gap:8px; padding:10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; background:#f8fafc;">
                    <input type="checkbox" id="pdf-filter-cash" checked style="width:18px; height:18px;">
                    <span>Uang CASH (Kas Fisik)</span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; padding:10px; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; background:#f8fafc;">
                    <input type="checkbox" id="pdf-filter-trf" checked style="width:18px; height:18px;">
                    <span>Uang TRANSFER (Talangan Pribadi)</span>
                </label>
            </div>

            <div style="display:flex; gap:8px;">
                <button type="button" onclick="document.getElementById('modal-cetak-pdf-dompet').style.display='none'" style="flex:1; padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; font-weight:700; font-size:12px; color:#64748b; cursor:pointer;">Batal</button>
                <button type="button" id="btn-proses-pdf" onclick="eksekusiCetakPDF()" style="flex:2; padding:10px; border:none; border-radius:8px; background:#ea580c; font-weight:800; font-size:13px; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                    <span class="material-symbols-outlined" style="font-size:18px;">picture_as_pdf</span> Cetak / Unduh PDF
                </button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

async function eksekusiCetakPDF() {
    let incCash = document.getElementById('pdf-filter-cash')?.checked || false;
    let incTrf = document.getElementById('pdf-filter-trf')?.checked || false;

    if (!incCash && !incTrf) {
        return alert("Harap centang minimal salah satu metode (Cash atau Transfer)!");
    }

    let items = dompetDataAktif.filter(item => dompetCheckedIds.has(item.id));
    if (items.length === 0) items = dompetDataAktif;

    items = items.filter(item => {
        if (item.metode === 'Cash' && incCash) return true;
        if (item.metode === 'Transfer' && incTrf) return true;
        return false;
    });

    if (items.length === 0) {
        return alert("Tidak ada data pengeluaran yang cocok untuk dicetak.");
    }

    let btn = document.getElementById('btn-proses-pdf');
    btn.disabled = true;
    btn.innerText = "Menyiapkan Dokumen...";

    try {
        let now = new Date();
        let tglFormat = ("0" + now.getDate()).slice(-2) + "/" + ("0" + (now.getMonth() + 1)).slice(-2) + "/" + now.getFullYear();
        let jamFormat = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
        let petName = typeof activeUser !== 'undefined' && activeUser ? activeUser : 'Wildan';
        let batchId = `RMB-${now.toISOString().split('T')[0].replace(/-/g, '')}-${jamFormat.replace(':', '')}`;

        let totalCash = 0;
        let totalTrf = 0;

        let tableRowsHtml = items.map((it, idx) => {
            let n = parseInt(it.nominal) || 0;
            if (it.metode === 'Cash') totalCash += n;
            else totalTrf += n;

            let tglItem = it.tanggal ? it.tanggal.split('-').reverse().join('/') : '';
            return `
                <tr>
                    <td style="text-align:center; padding:6px; border:1px solid #94a3b8; font-size:11px;">${idx + 1}</td>
                    <td style="text-align:center; padding:6px; border:1px solid #94a3b8; font-size:11px; white-space:nowrap;">${tglItem}</td>
                    <td style="padding:6px; border:1px solid #94a3b8; font-size:11px; font-weight:700;">${it.kategori || '-'}</td>
                    <td style="padding:6px; border:1px solid #94a3b8; font-size:11px;">${it.relasi ? '<b>' + it.relasi + '</b> - ' : ''}${it.keterangan || '-'}</td>
                    <td style="text-align:center; padding:6px; border:1px solid #94a3b8; font-size:11px; font-weight:700;">${it.metode}</td>
                    <td style="text-align:right; padding:6px; border:1px solid #94a3b8; font-size:11px; font-weight:700;">Rp ${n.toLocaleString('id-ID')}</td>
                </tr>
            `;
        }).join('');

        let totalSemua = totalCash + totalTrf;
        let sisaKasFisik = dompetPlafon - totalCash;

        let printDoc = document.createElement('div');
        printDoc.id = 'virtual-print-rekap-rembes';
        printDoc.style.cssText = 'width:750px; background:#fff; padding:30px; font-family:"Poppins", Arial, sans-serif; color:#0f172a; box-sizing:border-box; margin:0 auto;';

        printDoc.innerHTML = `
            <div style="border-bottom:2px solid #0f172a; padding-bottom:10px; margin-bottom:15px; text-align:center;">
                <h1 style="font-size:18px; font-weight:800; margin:0; text-transform:uppercase; color:#1a5c40; letter-spacing:0.5px;">PT CITA BENGGALA LESTARI</h1>
                <h2 style="font-size:13px; font-weight:700; margin:3px 0 0 0; color:#334155;">FORM PENGAJUAN REIMBURSEMENT & MUTASI KAS</h2>
            </div>

            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:15px;">
                <div>
                    <div>No. Dokumen : <b>${batchId}</b></div>
                    <div>Pemegang Kas : <b>${petName}</b></div>
                </div>
                <div style="text-align:right;">
                    <div>Waktu Cetak : <b>${tglFormat}, Pukul ${jamFormat} WIB</b></div>
                    <div>Metode Dana : <b>${incCash && incTrf ? 'CASH & TRANSFER' : incCash ? 'CASH SAJA' : 'TRANSFER SAJA'}</b></div>
                </div>
            </div>

            <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:10px 12px; margin-bottom:15px; font-size:11px;">
                <div style="font-weight:800; color:#1a5c40; margin-bottom:5px; border-bottom:1px dashed #cbd5e1; padding-bottom:3px;">RINGKASAN KAS & KLAIM:</div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>
                        ${incCash ? `<div>• Plafon Kas Fisik : Rp ${dompetPlafon.toLocaleString('id-ID')}</div>` : ''}
                        ${incCash ? `<div>• Pengeluaran Cash : Rp ${totalCash.toLocaleString('id-ID')}</div>` : ''}
                        ${incCash ? `<div>• Sisa Kas Fisik di Tangan : <b>Rp ${sisaKasFisik.toLocaleString('id-ID')}</b></div>` : ''}
                    </div>
                    <div>
                        ${incCash ? `<div>Klaim Cash : Rp ${totalCash.toLocaleString('id-ID')}</div>` : ''}
                        ${incTrf ? `<div>Klaim Transfer : Rp ${totalTrf.toLocaleString('id-ID')}</div>` : ''}
                        <div style="margin-top:4px; font-size:12px; font-weight:800; color:#b91c1c;">
                            TOTAL KLAIM : Rp ${totalSemua.toLocaleString('id-ID')}
                        </div>
                    </div>
                </div>
            </div>

            <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <thead>
                    <tr style="background:#f1f5f9; color:#0f172a;">
                        <th style="padding:6px; border:1px solid #94a3b8; font-size:11px; width:30px;">NO</th>
                        <th style="padding:6px; border:1px solid #94a3b8; font-size:11px; width:75px;">TANGGAL</th>
                        <th style="padding:6px; border:1px solid #94a3b8; font-size:11px; width:130px;">KATEGORI</th>
                        <th style="padding:6px; border:1px solid #94a3b8; font-size:11px;">URAIAN / RELASI / KETERANGAN</th>
                        <th style="padding:6px; border:1px solid #94a3b8; font-size:11px; width:65px;">METODE</th>
                        <th style="padding:6px; border:1px solid #94a3b8; font-size:11px; width:100px;">NOMINAL (RP)</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRowsHtml}
                </tbody>
                <tfoot>
                    <tr style="background:#f8fafc; font-weight:800;">
                        <td colspan="5" style="text-align:right; padding:8px; border:1px solid #94a3b8; font-size:11px;">TOTAL PENGAJUAN</td>
                        <td style="text-align:right; padding:8px; border:1px solid #94a3b8; font-size:12px; color:#1a5c40;">Rp ${totalSemua.toLocaleString('id-ID')}</td>
                    </tr>
                </tfoot>
            </table>

            <div style="display:flex; justify-content:flex-end; margin-top:25px;">
                <div style="text-align:center; width:220px; font-size:11px;">
                    <div>Diajukan Oleh,</div>
                    <div style="font-size:10px; color:#64748b;">( Pukul ${jamFormat} WIB )</div>
                    <div style="height:55px;"></div>
                    <div style="font-weight:800; text-decoration:underline;">( ${petName} )</div>
                    <div style="color:#64748b; font-size:10px;">Pemegang Kas Operasional</div>
                </div>
            </div>
        `;

        document.body.appendChild(printDoc);

        let opt = {
            margin: [10, 10, 10, 10],
            filename: `Rekap_Reimburse_${batchId}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, width: 750 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        if (typeof html2pdf !== 'undefined') {
            await html2pdf().set(opt).from(printDoc).save();
        } else {
            window.print();
        }

        document.body.removeChild(printDoc);
        document.getElementById('modal-cetak-pdf-dompet').style.display = 'none';

    } catch (err) {
        alert("Gagal mencetak dokumen: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Cetak / Unduh PDF";
    }
}

/**
 * AUTO-SYNC DARI LAPORAN GUDANG (BONGKAR MUAT CASH OUT)
 */
async function syncBongkarMuatKeDompet({ tanggal, nominal, keterangan, relasi, cabangStr, petugas, cashflowId, buktiUrl }) {
    try {
        let sUrl = typeof SUPA_URL !== 'undefined' ? SUPA_URL : 'https://hwpbkdmaeqovhxttkrmj.supabase.co';
        let sKey = typeof SUPA_ANON_KEY !== 'undefined' ? SUPA_ANON_KEY : '';
        let petName = petugas || (typeof activeUser !== 'undefined' && activeUser ? activeUser : 'Wildan');
        let cleanBukti = (buktiUrl && buktiUrl !== '-') ? buktiUrl : '-';

        let payload = {
            tanggal: tanggal || new Date().toISOString().split('T')[0],
            waktu: new Date().toTimeString().slice(0, 5),
            jenis: 'Keluar',
            metode: 'Cash',
            kategori: 'Bongkar Muat',
            relasi: relasi || `Kuli Gudang ${cabangStr || ''}`,
            nominal: nominal,
            keterangan: keterangan || `Upah bongkar pakan masuk`,
            bukti_url: cleanBukti,
            struk_status: (cleanBukti !== '-') ? 'ada' : 'tidak_ada',
            masuk_cashflow: true,
            cashflow_id: cashflowId || null,
            status_reimburse: 'BELUM',
            petugas: petName
        };

        let resDompet = await fetch(`${sUrl}/rest/v1/dompet_rembes`, {
            method: 'POST',
            headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resDompet.ok) {
            console.error("Gagal insert Bongkar Muat ke Dompet Rembes:", await resDompet.text());
            return;
        }

        console.log("Auto-sync Bongkar Muat ke Dompet Rembes Berhasil (cashflow_id:", cashflowId || null, ")");
        if (typeof muatDataDompet === 'function') {
            muatDataDompet(true);
        }
    } catch (e) {
        console.error("Gagal auto-sync Bongkar Muat ke Dompet Rembes:", e);
    }
}

/**
 * Switch Sub-Mode Cashflow: Input Cashflow Standar vs Dompet Reimburse
 */
function switchSubCashflow(subMode) {
    let btnInput = document.getElementById('btn-sub-cf-input');
    let btnDompet = document.getElementById('btn-sub-cf-dompet');
    let viewInput = document.getElementById('sub-view-cf-input');
    let viewDompet = document.getElementById('view-dompet-rembes');

    if (!btnInput || !btnDompet || !viewInput || !viewDompet) return;

    if (subMode === 'input') {
        btnInput.style.background = '#1a5c40';
        btnInput.style.color = '#ffffff';
        btnInput.style.fontWeight = '800';
        btnDompet.style.background = 'transparent';
        btnDompet.style.color = '#64748b';
        btnDompet.style.fontWeight = '700';

        viewInput.classList.remove('hidden');
        viewDompet.classList.add('hidden');
    } else {
        btnDompet.style.background = '#1a5c40';
        btnDompet.style.color = '#ffffff';
        btnDompet.style.fontWeight = '800';
        btnInput.style.background = 'transparent';
        btnInput.style.color = '#64748b';
        btnInput.style.fontWeight = '700';

        viewInput.classList.add('hidden');
        viewDompet.classList.remove('hidden');

        if (typeof initDompetRembes === 'function') {
            initDompetRembes();
        }
    }
}
window.switchSubCashflow = switchSubCashflow;
window.setDompetJenis = setDompetJenis;
window.setDompetMetode = setDompetMetode;
