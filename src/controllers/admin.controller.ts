import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';

const prisma = new PrismaClient();
const IST_TIMEZONE = 'Asia/Kolkata';

// Helper: Get current date string in IST (YYYY-MM-DD)
function getISTDateStr(date?: Date): string {
  const d = date || new Date();
  return d.toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
}

// Helper: Format a Date to IST time string (e.g. "09:30 AM")
function formatISTTime(dateObj: Date): string {
  return dateObj.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: IST_TIMEZONE,
  });
}

// 1. Admin Login API
export async function loginAdmin(req: Request, res: Response) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const matches = await bcrypt.compare(password, admin.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforattendxapp';
    const token = jwt.sign({ id: admin.id, role: admin.role }, JWT_SECRET, {
      expiresIn: '8h',
    });

    return res.json({ token, username: admin.username, role: admin.role });
  } catch (err) {
    return res.status(500).json({ error: 'Admin authentication failed: ' + err });
  }
}

// 2. Fetch Stats & Chart Data for HR Dashboard
export async function getDashboardStats(req: Request, res: Response) {
  try {
    const totalEmployees = await prisma.employee.count();

    const todayStr = getISTDateStr();
    const todayAttendance = await prisma.attendance.findMany({
      where: { date: todayStr },
    });

    const presentToday = todayAttendance.filter((l) => l.status === 'Present').length;
    const absentToday = todayAttendance.filter((l) => l.status === 'Absent').length;
    const pendingPunchOuts = todayAttendance.filter((l) => l.punchIn && !l.punchOut).length;

    const attendancePercentage =
      totalEmployees > 0 ? Math.round((presentToday / totalEmployees) * 100) : 100;

    // Fetch weekly stats
    const weeklyData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = getISTDateStr(d);

      const count = await prisma.attendance.count({
        where: { date: dateStr, status: 'Present' },
      });

      const dayName = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: IST_TIMEZONE });
      weeklyData.push({ day: dayName, count });
    }

    return res.json({
      metrics: {
        totalEmployees,
        presentToday,
        absentToday,
        pendingPunchOuts,
        attendancePercentage,
      },
      charts: {
        weekly: weeklyData,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch dashboard metrics: ' + err });
  }
}

// 3. Employee Management: Search, Filter, Sort
export async function getEmployeesList(req: Request, res: Response) {
  const { search, sortBy } = req.query;

  try {
    const employees = await prisma.employee.findMany({
      where: search
        ? {
          OR: [
            { name: { contains: String(search), mode: 'insensitive' } },
            { phone: { contains: String(search) } },
          ],
        }
        : {},
      include: {
        embeddings: true,
      },
      orderBy: sortBy === 'name' ? { name: 'asc' } : { registeredAt: 'desc' },
    });

    const list = employees.map((emp) => ({
      id: emp.id,
      name: emp.name,
      phone: emp.phone,
      registeredAt: emp.registeredAt,
      hasEmbeddings: emp.embeddings.length > 0,
    }));

    return res.json(list);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch employee list: ' + err });
  }
}

// 4. Delete Employee
export async function deleteEmployee(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await prisma.employee.delete({ where: { id } });

    // Log action in Audit log
    await prisma.auditLog.create({
      data: {
        action: 'DELETE_EMPLOYEE',
        performedBy: 'Admin',
        details: `Deleted employee with ID: ${id}`,
      },
    });

    return res.json({ message: 'Employee profile deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete employee: ' + err });
  }
}

// 5. Reset Face Embeddings
export async function resetFaceEmbeddings(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await prisma.faceEmbedding.deleteMany({
      where: { employeeId: id },
    });

    // Log action
    await prisma.auditLog.create({
      data: {
        action: 'RESET_FACE_EMBEDDINGS',
        performedBy: 'Admin',
        details: `Reset face biometrics for employee ID: ${id}`,
      },
    });

    return res.json({ message: 'Face embeddings reset successfully. Employee must re-register on next login.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset face: ' + err });
  }
}

// 6. Fetch Logs with Selfie Info (supports ?date=YYYY-MM-DD and ?sort=name)
export async function getAttendanceLogs(req: Request, res: Response) {
  try {
    const { date, sort } = req.query;
    const filterDate = date ? String(date) : getISTDateStr(); // Default to today

    const logs = await prisma.attendance.findMany({
      where: { date: filterDate },
      include: {
        employee: true,
      },
      orderBy: sort === 'name' 
        ? { employee: { name: 'asc' } } 
        : { date: 'desc' },
      take: 500,
    });

    // Match verification selfies using a ±5 minute time window
    const SELFIE_MATCH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes tolerance

    const result = await Promise.all(
      logs.map(async (log) => {
        let punchInSelfie = null;
        if (log.punchIn) {
          const punchInTime = new Date(log.punchIn);
          punchInSelfie = await prisma.verificationSelfie.findFirst({
            where: {
              employeeId: log.employeeId,
              type: 'IN',
              timestamp: {
                gte: new Date(punchInTime.getTime() - SELFIE_MATCH_WINDOW_MS),
                lte: new Date(punchInTime.getTime() + SELFIE_MATCH_WINDOW_MS),
              },
            },
            select: { id: true, gpsAccuracy: true },
            orderBy: { timestamp: 'desc' },
          });
        }

        let punchOutSelfie = null;
        if (log.punchOut) {
          const punchOutTime = new Date(log.punchOut);
          punchOutSelfie = await prisma.verificationSelfie.findFirst({
            where: {
              employeeId: log.employeeId,
              type: 'OUT',
              timestamp: {
                gte: new Date(punchOutTime.getTime() - SELFIE_MATCH_WINDOW_MS),
                lte: new Date(punchOutTime.getTime() + SELFIE_MATCH_WINDOW_MS),
              },
            },
            select: { id: true, gpsAccuracy: true },
            orderBy: { timestamp: 'desc' },
          });
        }

        return {
          id: log.id,
          employeeId: log.employeeId,
          name: log.employee.name,
          date: log.date,
          punchIn: log.punchIn ? log.punchIn.toISOString() : null,
          punchOut: log.punchOut ? log.punchOut.toISOString() : null,
          status: log.status,
          device: log.deviceInfo || 'Unknown',
          browser: log.browserInfo || 'Unknown',
          punchInSelfieId: punchInSelfie?.id || null,
          punchOutSelfieId: punchOutSelfie?.id || null,
        };
      })
    );

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch logs: ' + err });
  }
}

// 7. Get Verification Selfie Image bytes
export async function getSelfieRecord(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const selfie = await prisma.verificationSelfie.findUnique({
      where: { id },
    });
    if (!selfie) {
      return res.status(404).json({ error: 'Verification selfie not found.' });
    }
    return res.json({
      id: selfie.id,
      timestamp: selfie.timestamp.toISOString(),
      latitude: selfie.latitude,
      longitude: selfie.longitude,
      gpsAccuracy: selfie.gpsAccuracy,
      type: selfie.type,
      image: selfie.imageBytes, // Base64 data string
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load selfie record: ' + err });
  }
}

// 8. Manual Logs Adjustment Override
export async function adjustAttendanceLog(req: Request, res: Response) {
  const { id, punchIn, punchOut, status } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Log ID is required.' });
  }

  try {
    const existing = await prisma.attendance.findUnique({
      where: { id },
      include: { employee: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Log record not found.' });
    }

    const updatedIn = punchIn ? new Date(punchIn) : null;
    const updatedOut = punchOut ? new Date(punchOut) : null;

    await prisma.attendance.update({
      where: { id },
      data: {
        punchIn: updatedIn,
        punchOut: updatedOut,
        status: status || 'Present',
      },
    });

    // Log the change in AuditLogs
    await prisma.auditLog.create({
      data: {
        action: 'ADJUST_ATTENDANCE',
        performedBy: 'Admin',
        details: `Adjusted log for ${existing.employee.name} on ${existing.date}. In: ${punchIn}, Out: ${punchOut}, Status: ${status}`,
      },
    });

    return res.json({ message: 'Attendance log adjusted successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to adjust logs: ' + err });
  }
}

// 9. Geofence configuration Settings fetch/save
export async function getGeofenceSettings(req: Request, res: Response) {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'global_settings' },
    });
    return res.json(settings);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load settings: ' + err });
  }
}

export async function saveGeofenceSettings(req: Request, res: Response) {
  const { officeName, latitude, longitude, radiusMeters, minHoursBeforePunchOut } = req.body;

  try {
    const settings = await prisma.settings.update({
      where: { id: 'global_settings' },
      data: {
        officeName: officeName || 'AttendX HQ',
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        radiusMeters: parseFloat(radiusMeters),
        minHoursBeforePunchOut: parseFloat(minHoursBeforePunchOut),
      },
    });

    // Audit logs
    await prisma.auditLog.create({
      data: {
        action: 'UPDATE_GEOFENCE_SETTINGS',
        performedBy: 'Admin',
        details: `Updated geofence to ${officeName} (${latitude}, ${longitude}) - radius: ${radiusMeters}m`,
      },
    });

    return res.json({ message: 'Settings saved successfully.', settings });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save settings: ' + err });
  }
}

// 11. Change Admin Secret Code (Security Settings)
export async function changeAdminSecretCode(req: Request, res: Response) {
  const { currentSecretCode, newSecretCode } = req.body;

  if (!currentSecretCode || !newSecretCode) {
    return res.status(400).json({ error: 'Current and new secret codes are required.' });
  }

  if (String(newSecretCode).trim().length < 4) {
    return res.status(400).json({ error: 'New secret code must be at least 4 characters long.' });
  }

  try {
    const admin = await prisma.admin.findFirst();
    if (!admin) {
      return res.status(404).json({ error: 'Admin user not found.' });
    }

    if (admin.secretCodeHash) {
      const isMatch = await bcrypt.compare(String(currentSecretCode).trim(), admin.secretCodeHash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Current secret code is incorrect.' });
      }
    }

    const newHash = await bcrypt.hash(String(newSecretCode).trim(), 10);
    await prisma.admin.update({
      where: { id: admin.id },
      data: { secretCodeHash: newHash },
    });

    await prisma.auditLog.create({
      data: {
        action: 'CHANGE_ADMIN_SECRET_CODE',
        performedBy: admin.username,
        details: 'Admin secret code successfully updated.',
      },
    });

    return res.json({ message: 'Admin Secret Code updated successfully.' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to update Secret Code: ' + (err.message || err) });
  }
}

// 10. Generate and Export Excel Workbook Sheet (ExcelJS) for NSM & Associates
export async function exportAttendanceExcel(req: Request, res: Response) {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Attendance Register');

    const now = new Date();
    // Use IST timezone for month/year calculations
    const istNowStr = now.toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
    const [istYear, istMonthStr] = istNowStr.split('-');
    const currentYear = parseInt(istYear, 10);
    const currentMonth = parseInt(istMonthStr, 10) - 1; // 0-11
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const monthNameLong = now.toLocaleString('en-US', { month: 'long', timeZone: IST_TIMEZONE });

    // 1. Build Title & Header Blocks
    sheet.addRow(['NSM & ASSOCIATES — ATTENDANCE REGISTER']);
    sheet.addRow([`Month: ${monthNameLong} ${currentYear}`]);
    sheet.addRow([]); // Blank Row 3

    sheet.getRow(1).font = { name: 'Calibri', size: 14, bold: true, color: { argb: '000000' } };
    sheet.getRow(2).font = { name: 'Calibri', size: 10, italic: true, color: { argb: '595959' } };

    // 2. Prepare Row 4 Table Headers (No Employee ID column!)
    const headers: string[] = ['Name', 'Phone Number'];
    const columns: any[] = [
      { key: 'name', width: 22 },
      { key: 'phone', width: 16 },
    ];

    for (let day = 1; day <= daysInMonth; day++) {
      const checkDate = new Date(currentYear, currentMonth, day);
      const dayName = checkDate.getDate();
      const monthNameShort = checkDate.toLocaleString('en-US', { month: 'short' });

      headers.push(`${dayName} ${monthNameShort}`, 'In', 'Out', 'Hours');

      columns.push({ key: `d${day}_status`, width: 10 });
      columns.push({ key: `d${day}_in`, width: 11 });
      columns.push({ key: `d${day}_out`, width: 11 });
      columns.push({ key: `d${day}_hours`, width: 11 });
    }

    headers.push('Present Days', 'Absent Days', 'Total Hours');
    columns.push({ key: 'total_present', width: 13 });
    columns.push({ key: 'total_absent', width: 13 });
    columns.push({ key: 'total_working_hours', width: 14 });

    sheet.addRow(headers);
    sheet.columns = columns;

    const headerRow = sheet.getRow(4);
    headerRow.height = 24;
    headerRow.font = { name: 'Calibri', size: 11, bold: true, color: { argb: '000000' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    const thinBorder = {
      top: { style: 'thin', color: { argb: 'D3D3D3' } },
      left: { style: 'thin', color: { argb: 'D3D3D3' } },
      bottom: { style: 'thin', color: { argb: 'D3D3D3' } },
      right: { style: 'thin', color: { argb: 'D3D3D3' } },
    } as const;

    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'F2F2F2' },
      };
      cell.border = thinBorder;
    });

    // 3. Query Attendance Database
    const currentMonthStr = `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}`;
    const employees = await prisma.employee.findMany({
      where: { active: true },
      include: {
        attendance: {
          where: {
            date: {
              startsWith: currentMonthStr,
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    employees.forEach((emp) => {
      const rowData: any = {
        name: emp.name,
        phone: emp.phone,
      };

      let presentCount = 0;
      let absentCount = 0;
      let totalWorkMs = 0;

      const dailyMap: { [key: number]: (typeof emp.attendance)[0] } = {};
      emp.attendance.forEach((att) => {
        const dayParts = att.date.split('-');
        const dayNum = parseInt(dayParts[2], 10);
        dailyMap[dayNum] = att;
      });

      // Use IST date for today's day number
      const todayIST = getISTDateStr();
      const todayParts = todayIST.split('-');
      const todayYearIST = parseInt(todayParts[0], 10);
      const todayMonthIST = parseInt(todayParts[1], 10) - 1;
      const todayDayNum = parseInt(todayParts[2], 10);
      const isCurrentMonth = currentMonth === todayMonthIST && currentYear === todayYearIST;

      for (let day = 1; day <= daysInMonth; day++) {
        const record = dailyMap[day];
        const checkDate = new Date(currentYear, currentMonth, day);
        const isSunday = checkDate.getDay() === 0;
        const isPastDay = !isCurrentMonth || day < todayDayNum;

        if (record && record.punchIn) {
          const checkIn = new Date(record.punchIn);

          rowData[`d${day}_in`] = formatISTTime(checkIn);

          if (record.punchOut) {
            const checkOut = new Date(record.punchOut);
            rowData[`d${day}_out`] = formatISTTime(checkOut);
            const durationMs = checkOut.getTime() - checkIn.getTime();
            if (durationMs > 0) {
              totalWorkMs += durationMs;
              const hrs = (durationMs / (1000 * 60 * 60)).toFixed(1);
              rowData[`d${day}_hours`] = `${hrs} hrs`;
            } else {
              rowData[`d${day}_hours`] = '-';
            }
          } else {
            rowData[`d${day}_out`] = '-';
            rowData[`d${day}_hours`] = '-';
          }

          rowData[`d${day}_status`] = 'P';
          presentCount++;
        } else {
          if (isSunday) {
            rowData[`d${day}_status`] = 'SUN';
            rowData[`d${day}_in`] = '-';
            rowData[`d${day}_out`] = '-';
            rowData[`d${day}_hours`] = '-';
          } else if (isPastDay) {
            rowData[`d${day}_status`] = 'A';
            rowData[`d${day}_in`] = '-';
            rowData[`d${day}_out`] = '-';
            rowData[`d${day}_hours`] = '-';
            absentCount++;
          } else {
            rowData[`d${day}_status`] = '-';
            rowData[`d${day}_in`] = '-';
            rowData[`d${day}_out`] = '-';
            rowData[`d${day}_hours`] = '-';
          }
        }
      }

      rowData['total_present'] = presentCount;
      rowData['total_absent'] = absentCount;
      rowData['total_working_hours'] = `${(totalWorkMs / (1000 * 60 * 60)).toFixed(1)} hrs`;

      const newRow = sheet.addRow(rowData);
      newRow.height = 20;

      newRow.eachCell((cell, colNumber) => {
        cell.border = thinBorder;
        cell.font = { name: 'Calibri', size: 11 };

        if (colNumber === 1 || colNumber === 2) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        }
      });

      // Status cell formatting
      for (let day = 1; day <= daysInMonth; day++) {
        const colIdx = 3 + (day - 1) * 4;
        const statusCell = newRow.getCell(colIdx);
        const val = statusCell.value;

        if (val === 'P') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'C6EFCE' },
          };
          statusCell.font = { name: 'Calibri', color: { argb: '006100' }, bold: true };
        } else if (val === 'A') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFC7CE' },
          };
          statusCell.font = { name: 'Calibri', color: { argb: '9C0006' }, bold: true };
        } else if (val === 'SUN') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEB9C' },
          };
          statusCell.font = { name: 'Calibri', color: { argb: '9C6500' }, bold: true };
        }
      }
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=' + `NSM_Associates_Attendance_${currentYear}_${currentMonth + 1}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[EXCEL ERROR] Export compilation failed: ', err);
    return res.status(500).json({ error: 'Failed to generate Excel report: ' + err });
  }
}

