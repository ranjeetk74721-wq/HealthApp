import { Platform } from "react-native";

export interface PrintPatientItem {
  token_number?: number | string;
  patient_name?: string;
  patient_mobile?: string;
  patient_address?: string;
  payment_amount?: number | string | null;
  payment_status?: string | null;
  status?: string | null;
}

export interface PrintPatientListOptions {
  hospitalName?: string;
  doctorName?: string;
  date: string;
  filterLabel?: string;
  patients: PrintPatientItem[];
}

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function printPatientList({
  hospitalName,
  doctorName,
  date,
  filterLabel,
  patients,
}: PrintPatientListOptions) {
  if (Platform.OS !== "web" || typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const clinicTitle = hospitalName?.trim() || "MeriBaari Clinic";
  const doctorTitle = doctorName?.trim()
    ? doctorName.startsWith("Dr.")
      ? doctorName
      : `Dr. ${doctorName}`
    : "Doctor";
  const filterDesc = filterLabel ? `(${filterLabel})` : "";
  const totalCount = patients.length;

  const rowsHtml =
    patients.length === 0
      ? `<tr><td colspan="7" style="text-align:center; padding: 24px; color: #64748b; font-style: italic;">No patients found matching the selected criteria.</td></tr>`
      : patients
          .map((p, idx) => {
            const serialNo = idx + 1;
            const tokenNo =
              p.token_number !== undefined && p.token_number !== null
                ? `#${p.token_number}`
                : "--";
            const patientName = p.patient_name?.trim() || "Not provided";
            const contactNo = p.patient_mobile?.trim() || "Not provided";
            const address = p.patient_address?.trim() || "Not provided";
            const amount =
              p.payment_amount !== undefined &&
              p.payment_amount !== null &&
              p.payment_amount !== ""
                ? `₹${p.payment_amount}`
                : "Not provided";
            const rawStatus = (p.payment_status || "").trim().toLowerCase();
            const statusText =
              rawStatus === "paid"
                ? "Paid"
                : rawStatus === "pending"
                ? "Pending"
                : rawStatus
                ? rawStatus.toUpperCase()
                : "Not provided";
            const statusBadgeClass =
              rawStatus === "paid"
                ? "badge-paid"
                : rawStatus === "pending"
                ? "badge-pending"
                : "badge-default";

            return `
              <tr>
                <td style="text-align: center; width: 45px;">${serialNo}</td>
                <td style="text-align: center; font-weight: 600; width: 65px;">${tokenNo}</td>
                <td style="font-weight: 600;">${escapeHtml(patientName)}</td>
                <td style="width: 105px;">${escapeHtml(contactNo)}</td>
                <td class="address-col">${escapeHtml(address)}</td>
                <td style="text-align: right; width: 90px; font-weight: 500;">${amount}</td>
                <td style="text-align: center; width: 85px;">
                  <span class="badge ${statusBadgeClass}">${escapeHtml(statusText)}</span>
                </td>
              </tr>
            `;
          })
          .join("\n");

  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Patient List - ${escapeHtml(doctorTitle)} - ${escapeHtml(date)}</title>
        <style>
          @page {
            size: A4 portrait;
            margin: 12mm 10mm;
          }
          @media print {
            thead {
              display: table-header-group;
            }
            tr {
              page-break-inside: avoid;
            }
            body {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            .no-print {
              display: none !important;
            }
          }
          * {
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #0f172a;
            background: #ffffff;
            margin: 0;
            padding: 8px 12px;
            font-size: 11px;
            line-height: 1.4;
          }
          .print-header {
            border-bottom: 2px solid #0369a1;
            padding-bottom: 10px;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
          }
          .clinic-name {
            font-size: 18px;
            font-weight: 700;
            color: #0369a1;
            margin: 0 0 3px 0;
          }
          .doctor-name {
            font-size: 13px;
            font-weight: 600;
            color: #1e293b;
            margin: 0 0 2px 0;
          }
          .list-title {
            font-size: 11px;
            font-weight: 500;
            color: #64748b;
          }
          .meta-box {
            text-align: right;
            font-size: 11px;
            color: #334155;
          }
          .meta-date {
            font-size: 13px;
            font-weight: 600;
            color: #0f172a;
          }
          .meta-count {
            margin-top: 3px;
            color: #64748b;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 6px;
          }
          th {
            background-color: #f1f5f9 !important;
            color: #0f172a;
            font-weight: 700;
            font-size: 10.5px;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            padding: 7px 6px;
            border: 1px solid #cbd5e1;
            text-align: left;
          }
          td {
            padding: 6px 6px;
            border: 1px solid #cbd5e1;
            vertical-align: top;
            font-size: 11px;
          }
          tr:nth-child(even) td {
            background-color: #f8fafc;
          }
          .address-col {
            max-width: 190px;
            word-wrap: break-word;
            word-break: break-word;
            white-space: normal;
          }
          .badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
            text-transform: capitalize;
          }
          .badge-paid {
            background-color: #d1fae5 !important;
            color: #065f46 !important;
          }
          .badge-pending {
            background-color: #fef3c7 !important;
            color: #92400e !important;
          }
          .badge-default {
            background-color: #f1f5f9 !important;
            color: #475569 !important;
          }
          .print-footer {
            margin-top: 14px;
            font-size: 10px;
            color: #94a3b8;
            text-align: center;
            border-top: 1px solid #e2e8f0;
            padding-top: 6px;
          }
        </style>
      </head>
      <body>
        <div class="print-header">
          <div>
            <div class="clinic-name">${escapeHtml(clinicTitle)}</div>
            <div class="doctor-name">${escapeHtml(doctorTitle)}</div>
            <div class="list-title">Patient Queue List ${escapeHtml(filterDesc)}</div>
          </div>
          <div class="meta-box">
            <div class="meta-date">Date: ${escapeHtml(date)}</div>
            <div class="meta-count">Total Patients: ${totalCount}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="text-align: center;">Serial Number</th>
              <th style="text-align: center;">Token Number</th>
              <th>Patient Name</th>
              <th>Contact Number</th>
              <th>Address</th>
              <th style="text-align: right;">Payment Amount</th>
              <th style="text-align: center;">Payment Status</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <div class="print-footer">
          Printed via MeriBaari Queue System · ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </div>
      </body>
    </html>
  `;

  try {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document || iframe.contentDocument;
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
      setTimeout(() => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        setTimeout(() => {
          try {
            document.body.removeChild(iframe);
          } catch {
            // Ignore
          }
        }, 1500);
      }, 350);
    }
  } catch {
    const printWin = window.open("", "_blank");
    if (printWin) {
      printWin.document.open();
      printWin.document.write(html);
      printWin.document.close();
      printWin.focus();
      printWin.print();
    }
  }
}
