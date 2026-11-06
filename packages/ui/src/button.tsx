import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = ['ehr-btn', variant === 'primary' ? 'ehr-btn--primary' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={cls} {...rest} />;
}
