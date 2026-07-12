import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';

const prisma = new PrismaClient();

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
    
    const todayStr = new Date().toISOString().split('T')[0];
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
      const dateStr = d.toISOString().split('T')[0];
      
      const count = await prisma.attendance.count({
        where: { date: dateStr, status: 'Present' },
      });
      
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
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

// 6. Fetch Logs with Selfie Info
export async function getAttendanceLogs(req: Request, res: Response) {
  try {
    const logs = await prisma.attendance.findMany({
      include: {
        employee: true,
      },
      orderBy: { date: 'desc' },
      take: 200,
    });

    // Match verification selfies
    const result = await Promise.all(
      logs.map(async (log) => {
        const punchInSelfie = await prisma.verificationSelfie.findFirst({
          where: { employeeId: log.employeeId, timestamp: log.punchIn || undefined, type: 'IN' },
          select: { id: true, gpsAccuracy: true },
        });

        const punchOutSelfie = await prisma.verificationSelfie.findFirst({
          where: { employeeId: log.employeeId, timestamp: log.punchOut || undefined, type: 'OUT' },
          select: { id: true, gpsAccuracy: true },
        });

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

// 10. Generate and Export Excel Workbook Sheet (ExcelJS) Match Image Format
export async function exportAttendanceExcel(req: Request, res: Response) {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('June Attendance');

    const now = new Date();
    const currentMonth = now.getMonth(); // 0-11
    const currentYear = now.getFullYear();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const monthNameLong = now.toLocaleString('en-US', { month: 'long' });

    // 1. Build Large Header Blocks
    sheet.addRow(['NSM & ASSOCIATES — ATTENDANCE GRID']);
    sheet.addRow([`Month: ${monthNameLong} ${currentYear}`]);
    sheet.addRow([]); // Blank Row 3

    // Apply styles to Header Rows
    sheet.getRow(1).font = { name: 'Calibri', size: 14, bold: true, color: { argb: '000000' } };
    sheet.getRow(2).font = { name: 'Calibri', size: 10, italic: true, color: { argb: '595959' } };

    // 2. Prepare Row 4 Table Headers
    const headers: string[] = ['ID', 'Name'];
    const columns: any[] = [
      { key: 'empId', width: 14 },
      { key: 'name', width: 22 }
    ];

    for (let day = 1; day <= daysInMonth; day++) {
      const checkDate = new Date(currentYear, currentMonth, day);
      const dayName = checkDate.getDate();
      const monthNameShort = checkDate.toLocaleString('en-US', { month: 'short' });
      
      headers.push(`${dayName} ${monthNameShort}`, 'In', 'Out');
      
      columns.push({ key: `d${day}_status`, width: 12 });
      columns.push({ key: `d${day}_in`, width: 12 });
      columns.push({ key: `d${day}_out`, width: 12 });
    }

    headers.push('Present', 'Absent');
    columns.push({ key: 'total_present', width: 12 });
    columns.push({ key: 'total_absent', width: 12 });

    // Add headers as Row 4
    sheet.addRow(headers);
    sheet.columns = columns;

    // Format Header Row (Row 4)
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

    // Header row background fill (Light gray)
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'F2F2F2' },
      };
      cell.border = thinBorder;
    });

    // 3. Query Attendance database
    const currentMonthStr = `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}`;
    const employees = await prisma.employee.findMany({
      include: {
        attendance: {
          where: {
            date: {
              startsWith: currentMonthStr,
            },
          },
        },
      },
    });

    employees.forEach((emp, empIdx) => {
      const rowData: any = {
        empId: `EMP-${emp.phone.slice(-4)}`, // Format like EMP-1002
        name: emp.name,
      };
      
      let presentCount = 0;
      let absentCount = 0;      // Group records by day (timezone-safe date mapping from DB logs)
      const dailyMap: { [key: number]: typeof emp.attendance[0] } = {};
      emp.attendance.forEach((att) => {
        const dayParts = att.date.split('-');
        const dayNum = parseInt(dayParts[2], 10);
        dailyMap[dayNum] = att;
      });

      const today = new Date();
      const isCurrentMonth = currentMonth === today.getMonth() && currentYear === today.getFullYear();
      const todayDayNum = today.getDate();

      for (let day = 1; day <= daysInMonth; day++) {
        const record = dailyMap[day];
        const checkDate = new Date(currentYear, currentMonth, day);
        const isSunday = checkDate.getDay() === 0;
        const isPastDay = !isCurrentMonth || (day < todayDayNum);

        if (record && record.punchIn) {
          const checkIn = new Date(record.punchIn);

          // Time format standard: "10:01 AM"
          const formatTime = (dateObj: Date) => {
            return dateObj.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true
            });
          };

          rowData[`d${day}_in`] = formatTime(checkIn);
          rowData[`d${day}_out`] = record.punchOut ? formatTime(new Date(record.punchOut)) : '-';
          rowData[`d${day}_status`] = 'P'; // Only Present (P)
          presentCount++;
        } else {
          // If no record exists
          if (isSunday || isPastDay) {
            rowData[`d${day}_status`] = 'A'; // Only Absent (A)
            rowData[`d${day}_in`] = '-';
            rowData[`d${day}_out`] = '-';
            absentCount++;
          } else {
            // Future / Current remaining days: blank status
            rowData[`d${day}_status`] = '-';
            rowData[`d${day}_in`] = '-';
            rowData[`d${day}_out`] = '-';
          }
        }
      }

      rowData['total_present'] = presentCount;
      rowData['total_absent'] = absentCount;

      const newRow = sheet.addRow(rowData);
      newRow.height = 20;

      // Apply cell formatting (alignment, border, and fills)
      newRow.eachCell((cell, colNumber) => {
        cell.border = thinBorder;
        cell.font = { name: 'Calibri', size: 11 };

        // Left-align ID and Name, center-align the rest
        if (colNumber === 1 || colNumber === 2) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        }
      });

      // Status columns colors formatting (P and A only)
      for (let day = 1; day <= daysInMonth; day++) {
        const colIdx = 3 + (day - 1) * 3; // Status column index
        const statusCell = newRow.getCell(colIdx);
        const val = statusCell.value;

        if (val === 'P') {
          // Present: Light Green fill
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'C6EFCE' },
          };
          statusCell.font = { name: 'Calibri', color: { argb: '006100' }, bold: true };
        } else if (val === 'A') {
          // Absent: Light Red fill
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFC7CE' },
          };
          statusCell.font = { name: 'Calibri', color: { argb: '9C0006' }, bold: true };
        }
      }
    });

    // Write headers and return sheet download response stream
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
