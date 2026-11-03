import { ConfigProvider, DatePicker, type DatePickerProps } from 'antd';
import './app-date-time-picker.css';

type AppDateTimePickerProps = Omit<DatePickerProps, 'format' | 'showTime' | 'classNames'>;

export function AppDateTimePicker(props: AppDateTimePickerProps) {
  return (
    <ConfigProvider
      theme={{
        token: { controlItemBgActive: '#e7f2f0', borderRadiusSM: 6 },
        components: {
          DatePicker: {
            cellActiveWithRangeBg: '#e7f2f0',
            cellHoverWithRangeBg: '#d4e9e5',
            cellHoverBg: '#f1f5f9',
            cellRangeBorderColor: '#76b1a9',
            cellWidth: 36,
            cellHeight: 24,
            textHeight: 40,
            timeColumnWidth: 48,
            timeColumnHeight: 224,
            timeCellHeight: 28,
            borderRadiusLG: 16,
          },
        },
      }}
    >
      <DatePicker
        {...props}
        classNames={{ popup: { root: 'app-date-time-picker-dropdown' } }}
        format="YYYY-MM-DD HH:mm"
        showTime={{ format: 'HH:mm', showSecond: false }}
      />
    </ConfigProvider>
  );
}
